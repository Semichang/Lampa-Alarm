(function () {
  'use strict';

  // Lampa Alarm v0.7.2: one-shot startup test and manual TorrServer replay.
  // Scheduled playback and Android system-volume control are still disabled.
  var VERSION = '0.7.2';
  var COMPONENT = 'lampa_alarm';
  var PREFIX = 'la_';
  var ICON = '<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l4 2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  var started = false;
  var weekdays = [
    { id: 1, title: 'Понедельник' },
    { id: 2, title: 'Вторник' },
    { id: 3, title: 'Среда' },
    { id: 4, title: 'Четверг' },
    { id: 5, title: 'Пятница' },
    { id: 6, title: 'Суббота' },
    { id: 0, title: 'Воскресенье' }
  ];

  if (window.__lampaAlarm072Loaded) return;
  window.__lampaAlarm072Loaded = true;

  // Best-effort wake detection: this cannot identify the TV power-on reason.
  // Unknown/unobserved wake never triggers a wake-guarded alarm.
  var wakeObservation = null;
  var hiddenAt = null;
  var lastHeartbeatAt = Date.now();
  var lastInteractionAt = 0;
  var startupSessionId = String(Date.now()) + '-' + String(Math.random()).slice(2);
  var startupTestTriggered = false;
  var launchInProgress = false;
  var startupTimer = null;
  var sessionOnline = null;
  var ONLINE_TTL_MS = 120000;
  var torrentLaunch = null;
  var onlineRoute = null;

  function markInteraction() { lastInteractionAt = Date.now(); }

  function wakeThresholdMs() {
    var minutes = Number(read('min_sleep', '30'));
    return (minutes > 0 && minutes <= 180 ? minutes : 30) * 60000;
  }

  function rememberWake(reason, inactivityMs, now) {
    if (inactivityMs < wakeThresholdMs()) return;
    wakeObservation = { at: now, reason: reason, inactivityMs: inactivityMs };
    save('last_wake_info', new Date(now).toLocaleString() + ' / ' +
      reason + ' / ' + Math.round(inactivityMs / 60000) + ' мин');
    log('Inactivity observed: ' + reason + ', ' + Math.round(inactivityMs / 1000) + ' seconds');
  }

  function checkHeartbeat() {
    var now = Date.now();
    var gap = now - lastHeartbeatAt;
    lastHeartbeatAt = now;
    if (!document.hidden && gap >= wakeThresholdMs()) {
      rememberWake('пауза таймера', gap, now);
    }
    if (!document.hidden && gap >= 30000)
      tryArmedStartupTest('пауза таймера', gap);
    checkSchedule();
  }

  function visibilityChanged() {
    var now = Date.now();
    if (document.hidden) {
      hiddenAt = now;
      return;
    }
    if (hiddenAt !== null) {
      var dormant = now - hiddenAt;
      rememberWake('возврат приложения', dormant, now);
      hiddenAt = null;
      if (dormant >= 10000) tryArmedStartupTest('возврат приложения', dormant);
    } else {
      var gap = now - lastHeartbeatAt;
      if (gap >= wakeThresholdMs()) rememberWake('пауза таймера', gap, now);
      if (gap >= 30000) tryArmedStartupTest('возобновление таймера', gap);
    }
    lastHeartbeatAt = now;
    checkSchedule();
  }

  function wakeStatusText() {
    if (!wakeObservation) return 'После запуска Lampa признаков пробуждения не было.';
    return 'Наблюдение: ' + wakeObservation.reason + ', ' +
      Math.round(wakeObservation.inactivityMs / 60000) + ' мин простоя.';
  }

  function log(message) {
    try { console.log('[Lampa Alarm ' + VERSION + '] ' + message); } catch (ignored) {}
  }
  function notice(message) {
    try {
      if (window.Lampa && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
        Lampa.Noty.show(message);
      } else {
        log(message);
      }
    } catch (e) {
      log('Notice error: ' + e.message);
    }
  }
  function read(key, defaultValue) {
    try {
      var value = Lampa.Storage.field(PREFIX + key);
      return value === undefined || value === null ? defaultValue : value;
    } catch (e) {
      return defaultValue;
    }
  }
  function save(key, value) {
    try { Lampa.Storage.set(PREFIX + key, value); }
    catch (e) { log('Storage error ' + key + ': ' + e.message); }
  }
  function enabled(key, defaultValue) {
    var value = read(key, defaultValue);
    return value === true || value === 'true' || value === 1;
  }
  function keyForDate(date) {
    var y = date.getFullYear();
    var m = ('0' + (date.getMonth() + 1)).slice(-2);
    var d = ('0' + date.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  function timeMinutes(value) {
    var match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(String(value || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  }
  // Saved card metadata, not a playback link. Streaming URLs are resolved later.
  function selectedSeries() {
    try {
      var series = Lampa.Storage.get(PREFIX + 'selected_series', '');
      if (!series || typeof series !== 'object') return null;
      if (!series.id || !series.title || series.media !== 'tv') return null;
      return {
        id: String(series.id),
        title: String(series.title),
        originalTitle: String(series.originalTitle || ''),
        source: String(series.source || 'tmdb'),
        media: 'tv',
        selectedAt: String(series.selectedAt || '')
      };
    } catch (e) { log('Selected series error: ' + e.message); return null; }
  }

  function storedValue(name, otherwise) {
    try { return Lampa.Storage.get(PREFIX + name, otherwise); }
    catch (e) { return otherwise; }
  }

  function torrentBookmark() {
    try {
      var item = storedValue('torrent_bookmark', '');
      if (!item || typeof item !== 'object') return null;
      if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[A-Za-z2-7]{32})$/.test(String(item.hash || ''))) return null;
      var index = Number(item.fileIndex);
      if (!isFinite(index) || Math.floor(index) !== index ||
          index < 0 || index > 100000) return null;
      return {
        seriesId: String(item.seriesId || ''),
        source: String(item.source || ''),
        hash: String(item.hash),
        fileIndex: index,
        season: episodeNumber(item.season),
        episode: episodeNumber(item.episode),
        episodeTitle: String(item.episodeTitle || '').slice(0, 200),
        savedAt: String(item.savedAt || '')
      };
    } catch (e) {
      log('Torrent bookmark error: ' + e.message);
      return null;
    }
  }

  function isBookmarkCurrent(bookmark, series) {
    return Boolean(bookmark && series &&
      bookmark.seriesId === series.id && bookmark.source === series.source);
  }


  // Accept the standard v1 hex (40), v2 hex (64) and v1 Base32 (32)
  // representations. The torrent/file identity is a local reference, not a URL.
  function validTorrentHash(hash) {
    return /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[A-Za-z2-7]{32})$/.test(String(hash || ''));
  }

  function parseTorrentStreamUrl(url) {
    var result = { hash: '', fileIndex: null };
    if (typeof url !== 'string' || url.length > 4096) return result;
    try {
      var link = /[?&]link=([^&#]+)/i.exec(url);
      var gst = /\/gst\/([^/?#]+)\/master\.m3u8/i.exec(url);
      var index = /[?&]index=([0-9]+)/i.exec(url);
      if (link || gst) {
        var part = (link || gst)[1];
        var decoded = decodeURIComponent(part);
        if (validTorrentHash(decoded)) result.hash = decoded;
      }
      if (index && /^[0-9]{1,6}$/.test(index[1])) {
        var fileIndex = Number(index[1]);
        if (fileIndex <= 100000) result.fileIndex = fileIndex;
      }
    } catch (e) { log('Could not parse stream identity: ' + e.message); }
    return result;
  }

  function torrentIdentityFromData(data) {
    var urlIdentity = parseTorrentStreamUrl(data && data.url);
    if (!data || typeof data !== 'object') {
      return { hash: '', fileIndex: null, reason: 'нет данных файла' };
    }

    var directHash = String(data.torrent_hash || '');
    var hash = validTorrentHash(directHash) ? directHash : urlIdentity.hash;

    var rawIndex = data.id;
    if (rawIndex === null || typeof rawIndex === 'undefined' || rawIndex === '') {
      rawIndex = data.file_index;
    }
    if (rawIndex === null || typeof rawIndex === 'undefined' || rawIndex === '') {
      rawIndex = data.fileIndex;
    }
    if (rawIndex === null || typeof rawIndex === 'undefined' || rawIndex === '') {
      rawIndex = urlIdentity.fileIndex;
    }
    var fileIndex = null;
    if (rawIndex !== null && typeof rawIndex !== 'undefined' && rawIndex !== '' &&
        /^[0-9]{1,6}$/.test(String(rawIndex))) {
      var value = Number(rawIndex);
      if (value <= 100000) fileIndex = value;
    }
    if (!hash) return { hash: '', fileIndex: fileIndex, reason: 'не получен корректный хэш торрента' };
    if (fileIndex === null) return { hash: hash, fileIndex: null, reason: 'не получен индекс видеофайла' };
    return { hash: hash, fileIndex: fileIndex, reason: 'ready' };
  }

  function saveTorrentIdentity(data, selected, observation) {
    if (!selected || !data || !isSameCard(data.card || data.movie, selected)) {
      return false;
    }
    var identity = torrentIdentityFromData(data);
    if (identity.reason !== 'ready') {
      save('torrent_save_status', identity.reason);
      log('Torrent identity not saved: ' + identity.reason);
      return false;
    }
    var tl = data.timeline && typeof data.timeline === 'object' ? data.timeline : {};
    var bookmark = {
      seriesId: selected.id,
      source: selected.source,
      hash: identity.hash,
      fileIndex: identity.fileIndex,
      season: observation && observation.season ||
        episodeNumber(tl.season || data.season),
      episode: observation && observation.episode ||
        episodeNumber(tl.episode || data.episode),
      episodeTitle: String(observation && observation.episodeTitle ||
        data.title || '').slice(0, 200),
      savedAt: new Date().toISOString()
    };
    save('torrent_bookmark', bookmark);
    save('torrent_save_status', 'ready');
    log('Torrent file identity saved: fileIndex=' + identity.fileIndex);
    return true;
  }

  function onTorrentFileEvent(event) {
    if (!event || event.type !== 'onenter' || !event.element) return;
    try {
      var selected = selectedSeries();
      var file = event.element;
      var fromList = event.params && event.params.movie;
      var card = file.card || fromList;
      if (!selected || !isSameCard(card, selected)) return;
      var metadata = {
        season: episodeNumber(file.season),
        episode: episodeNumber(file.episode),
        episodeTitle: String(file.title || '').slice(0, 200)
      };
      // The Lampa torrent-file event carries a chosen file even when an
      // external Android player doesn't provide full Player metadata.
      saveTorrentIdentity({
        torrent_hash: file.torrent_hash,
        id: file.id,
        url: file.url,
        card: card,
        title: file.title,
        season: file.season,
        episode: file.episode,
        timeline: file.timeline
      }, selected, metadata);
    } catch (e) { log('Torrent file selection error: ' + e.message); }
  }

  function bookmarkDiagnosticMessage() {
    var bookmark = torrentBookmark();
    var selected = selectedSeries();
    if (isBookmarkCurrent(bookmark, selected)) {
      return 'TorrServer: файл для повтора сохранён и готов к проверке.';
    }
    if (bookmark && selected && !isBookmarkCurrent(bookmark, selected)) {
      return 'TorrServer: сохранённый файл относится к другому сериалу.';
    }
    var reason = String(storedValue('torrent_save_status', '') || '');
    if (reason && reason !== 'ready')
      return 'TorrServer: файл не сохранён — ' + reason + '. Запусти серию снова.';
    var last = lastPlayback();
    if (last && last.sourceType === 'torrent')
      return 'Просмотр TorrServer найден, но хэш/индекс не были сохранены. ' +
        'Снова открой серию через TorrServer в этой версии плагина.';
    return 'Файл TorrServer не сохранён. Выбери сериал и запусти серию через TorrServer.';
  }

  function clearSavedReplay() {
    save('torrent_bookmark', '');
    save('torrent_save_status', '');
    save('last_playback', '');
    sessionOnline = null;
    currentPlayback = null;
    save('startup_test_enabled', false);
    save('startup_test_origin', '');
  }

  function clearSelectedSeries() {
    clearSavedReplay();
    save('selected_series', '');
    notice('Lampa Alarm: выбранный сериал сброшен');
  }

  function buildSeriesFromCard(card) {
    if (!card || typeof card !== 'object') return null;
    // TMDB / CUB TV cards use name or first_air_date; films use title/release_date.
    var isTv = Boolean(card.name || card.original_name || card.first_air_date ||
      Number(card.number_of_seasons) > 0);
    var id = card.id || card.tmdb_id;
    var title = card.name || card.title;
    if (!isTv || !id || !title) return null;
    return {
      id: String(id),
      title: String(title).slice(0, 180),
      originalTitle: String(card.original_name || card.original_title || '').slice(0, 180),
      source: String(card.source || 'tmdb').slice(0, 40),
      media: 'tv',
      selectedAt: new Date().toISOString()
    };
  }

  function chooseSeries(card) {
    var selected = buildSeriesFromCard(card);
    if (!selected) {
      notice('Будильник: не удалось определить сериал в карточке');
      return false;
    }
    var previouslySelected = selectedSeries();
    if (previouslySelected &&
        (previouslySelected.id !== selected.id ||
         previouslySelected.source !== selected.source)) clearSavedReplay();
    save('selected_series', selected);
    notice('Сериал для будильника: ' + selected.title);
    log('Series saved: ' + selected.source + ' / ' + selected.id);
    return true;
  }

  function addSeriesButton(e) {
    try {
      if (!e || e.type !== 'complite' || !e.data || !e.data.movie) return;
      if (!enabled('card_button', true)) return;
      var series = buildSeriesFromCard(e.data.movie);
      if (!series || !e.object || !e.object.activity ||
          typeof e.object.activity.render !== 'function') return;
      var root = e.object.activity.render();
      if (!root || !root.find) return;
      if (root.find('.lampa-alarm-card-button').length) return;

      var button = $('<div class="full-start__button selector lampa-alarm-card-button">' +
        '<svg viewBox="0 0 24 24" width="26" height="26" xmlns="http://www.w3.org/2000/svg" ' +
        'fill="none" stroke="currentColor" stroke-width="2">' +
        '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></svg>' +
        '<span>В будильник</span></div>');
      var current = selectedSeries();
      function refreshLabel() {
        var chosen = current && current.id === series.id &&
          current.source === series.source;
        button.find('span').text(chosen ? 'Выбран для будильника' : 'В будильник');
      }
      refreshLabel();
      button.on('hover:enter', function () {
        if (chooseSeries(e.data.movie)) {
          current = selectedSeries();
          refreshLabel();
        }
      });

      // Use the standard button container, without replacing native video buttons.
      var row = root.find('.full-start-new__buttons').first();
      if (!row.length) row = root.find('.buttons--container').first();
      if (row.length) row.append(button);
      else log('Card buttons container not found');
    } catch (err) {
      log('Card button error: ' + err.message);
    }
  }


  // Passive playback observations. Never persist stream URLs, auth headers,
  // playlists, JavaScript callbacks, or other potentially expiring credentials.
  var currentPlayback = null;
  var activeVideoHandlers = null;
  var lastProgressWrite = 0;

  function lastPlayback() {
    try {
      var item = Lampa.Storage.get(PREFIX + 'last_playback', '');
      if (!item || typeof item !== 'object' || !item.seriesId) return null;
      return item;
    } catch (e) {
      log('Read playback failed: ' + e.message);
      return null;
    }
  }

  function isSameCard(candidate, selected) {
    if (!candidate || !selected || typeof candidate !== 'object') return false;
    var id = candidate.id || candidate.tmdb_id;
    if (!id || String(id) !== selected.id) return false;
    var source = candidate.source;
    if (source && String(source) !== selected.source) return false;
    return true;
  }

  function timelineKeyForSeries(selected) {
    var key = 'tv_' + selected.id;
    if (selected.source !== 'tmdb' && selected.source !== 'cub')
      key = selected.source + '_' + key;
    return key.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64);
  }


  // Avoid mistaking a trailer or another show's stream for the selected series.
  // Context can establish the card only when a matching playback screen is active.
  var lastFullCard = null;
  var lastOnlineContext = null;
  var playerCreateContext = null;
  var lastRawPlayback = null;
  var lastRawAt = 0;

  function plainLabel(value, maxLength) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    var str = String(value).replace(/<[^>]*>/g, '').trim();
    if (!str || /(?:https?:\/\/|magnet:|bearer\s|(?:^|[?&])(?:token|key|auth)=|[?&][a-z_]+=)/i.test(str))
      return '';
    return str.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, maxLength || 120);
  }

  function numberOrNull(value) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    var n = Number(value);
    return isFinite(n) && n >= 1 && n <= 9999 && n === Math.floor(n) ? n : null;
  }

  function extractEpisodeFromTitle(value) {
    var s=plainLabel(value,240);
    if(!s) return {season:null,episode:null,method:''};
    var a=null,b=null,m;
    // Paired markers have priority over individual numbers. Use narrow
    // expressions to avoid confusing "2 сезон 8 серия" with season 8.
    m=/(?:^|[^a-z0-9])s(?:eason)?\s*0*(\d{1,2})[\s._:/-]*e(?:p(?:isode)?)?\s*0*(\d{1,3})(?!\d)/i.exec(s);
    if(m){a=numberOrNull(m[1]);b=numberOrNull(m[2]);}
    if(!a||!b){
      m=/(?:^|[^\d])0*(\d{1,2})\s*x\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if(m){a=numberOrNull(m[1]);b=numberOrNull(m[2]);}
    }
    // "S03 / 5" is a standard compact series/episode label.
    if(!a||!b){
      m=/(?:^|[^a-z0-9])s\s*0*(\d{1,2})\s*[/._-]\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if(m){a=numberOrNull(m[1]);b=numberOrNull(m[2]);}
    }
    // "2 сезон 8 серия", "2-й сезон, 8-я серия".
    if(!a||!b){
      m=/(?:^|[^\d])0*(\d{1,2})\s*(?:-?(?:й|ый|го))?\s*сезон[\s\S]{0,35}?(?:^|[^\d])0*(\d{1,3})\s*(?:-?(?:я|ая|ой))?\s*сер(?:ия|ии|ию|ий)(?![а-я])/i.exec(s);
      if(m){a=numberOrNull(m[1]);b=numberOrNull(m[2]);}
    }
    // "5 серия 2 сезона".
    if(!a||!b){
      m=/(?:^|[^\d])0*(\d{1,3})\s*(?:-?(?:я|ая|ой))?\s*сер(?:ия|ии|ию|ий)[\s\S]{0,35}?(?:^|[^\d])0*(\d{1,2})\s*(?:-?(?:й|ый|го))?\s*сезон/i.exec(s);
      if(m){a=numberOrNull(m[2]);b=numberOrNull(m[1]);}
    }
    // "Сезон 2 / Серия 9", "S1 / Серия 5",
    // "Season 1 / Episode 3".
    if(!a||!b){
      m=/(?:сезон(?:а|е)?|season|(?:^|[^a-z])s)\s*№?\s*0*(\d{1,2})[\s\S]{0,38}?(?:сер(?:ия|ии|ию|ий)|эпизод|episode|ep\.?)\s*№?\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if(m){a=numberOrNull(m[1]);b=numberOrNull(m[2]);}
    }
    if(!a||!b){
      // Partial information is kept partial, never fabricated.
      m=/(?:сер(?:ия|ии|ию|ий)|эпизод|episode|ep\.?)\s*№?\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if(m)b=numberOrNull(m[1]);
      if(!b){
        m=/(?:^|[^\d])0*(\d{1,3})\s*(?:-?(?:я|ая|ой))?\s*сер(?:ия|ии|ию|ий)(?![а-я])/i.exec(s);
        if(m)b=numberOrNull(m[1]);
      }
      m=/(?:сезон(?:а|е)?|season)\s*№?\s*0*(\d{1,2})(?!\d)/i.exec(s);
      if(m && !/(?:^|[^\d])\d+\s*(?:-?(?:й|ый|го))?\s*сезон/i.test(s))
        a=numberOrNull(m[1]);
      if(!a){
        m=/(?:^|[^\d])0*(\d{1,2})\s*(?:-?(?:й|ый|го))?\s*сезон/i.exec(s);
        if(m)a=numberOrNull(m[1]);
      }
    }
    return {season:a,episode:b,
      method:a&&b?'название':b?'частично из названия':''};
  }

  function episodeMetadata(data, context) {
    var tl = data && data.timeline && typeof data.timeline === 'object' ? data.timeline : {};
    var nested = [];
    if (data) {
      [data, tl, data.element, data.item, data.media, data.file, data.video].forEach(function(x) {
        if (x && typeof x === 'object') nested.push(x);
      });
    }
    var season=null,episode=null;
    for (var i=0;i<nested.length;i++){
      if (!season) season = numberOrNull(nested[i].season) || numberOrNull(nested[i].season_number);
      if (!episode) episode = numberOrNull(nested[i].episode) || numberOrNull(nested[i].episode_number);
    }
    var method = season && episode ? 'метаданные плеера' : '';
    var fields = [
      data && data.title, data && data.fname, data && data.name,
      data && data.episodeTitle, data && data.episode_title,
      tl && tl.title, data && data.element && data.element.title,
      data && data.item && data.item.title,
      context && context.focusedTitle
    ];
    for(var j=0;j<fields.length;j++){
      var parsed=extractEpisodeFromTitle(fields[j]);
      if(!season && parsed.season) season=parsed.season;
      if(!episode && parsed.episode) episode=parsed.episode;
      if (season && episode) {
        if(!method)method='метаданные + ' + (parsed.method || 'название');
        break;
      }
    }
    return { season:season, episode:episode, method:method ||
      (season || episode ? 'частично' : 'не определены') };
  }

  function sourceComponentIsOnline(component) {
    return /(?:online|vod|rezka|filmix|collaps|kinobase|lumex|bwa|showy|modss|stream|serials)/i.test(component);
  }

  function getCardFromActivity(activity) {
    if (!activity || typeof activity !== 'object') return null;
    return activity.movie || activity.card ||
      (activity.data && (activity.data.movie || activity.data.card)) ||
      (activity.object && (activity.object.movie || activity.object.card)) || null;
  }

  function getFocusedSeriesLabel(activity) {
    try {
      var view=activity && activity.activity &&
        typeof activity.activity.render==='function' ?
        activity.activity.render() : null;
      if (!view || typeof view.find!=='function') return '';
      // Read only a currently focused episode row of the active media screen.
      // No script URL, cookie, or network response is captured.
      var selectors=[
        '.online.selector.focus .online__title',
        '.online.focus .online__title',
        '.online_modss.focus .online_modss__title',
        '.online_modss--full.focus .online_modss__title',
        '.torrent-item.focus .online__title',
        '.selector.focus .online__title'
      ];
      for(var i=0;i<selectors.length;i++){
        var row=view.find(selectors[i]);
        if(row && row.length && typeof row.first==='function' &&
           typeof row.first().text==='function'){
          var label=plainLabel(row.first().text(),180);
          if(label)return label;
        }
      }
    }catch(e){log('Focused episode inspection failed: '+e.message);}
    return '';
  }

  function activitySnapshot(activity, selected, allowRecentFull) {
    if (!activity || !selected) return null;
    var component=plainLabel(activity.component || '',100);
    if (!component || /^(full|main|settings|player|youtube|trailer)$/i.test(component))
      return null;
    var card=getCardFromActivity(activity);
    if (card && (card.id || card.tmdb_id)) {
      if (!isSameCard(card,selected)) return null;
      return { at:Date.now(),component:component,
        title:plainLabel(activity.title || '',100),
        focusedTitle:getFocusedSeriesLabel(activity),
        method:'активный экран',
        selectedId:selected.id, selectedSource:selected.source };
    }
    if (allowRecentFull && sourceComponentIsOnline(component) &&
        lastFullCard && lastFullCard.selectedId===selected.id &&
        lastFullCard.selectedSource===selected.source &&
        Date.now()-lastFullCard.at<=30000) {
      return {at:Date.now(),component:component,
        title:plainLabel(activity.title || '',100),
        focusedTitle:getFocusedSeriesLabel(activity),
        method:'онлайн-экран после карточки',selectedId:selected.id,
        selectedSource:selected.source};
    }
    return null;
  }

  function detectActivityContext(selected) {
    try {
      if (!Lampa.Activity || typeof Lampa.Activity.active !== 'function') return null;
      return activitySnapshot(Lampa.Activity.active(), selected, true);
    } catch (e) { return null; }
  }

  function contextForPlayback(selected) {
    var activeActivity=null;
    try {
      if (Lampa.Activity && typeof Lampa.Activity.active==='function')
        activeActivity=Lampa.Activity.active();
    } catch(e){}
    if(activeActivity){
      var direct=activitySnapshot(activeActivity,selected,true);
      if(direct){
        lastOnlineContext=direct;
        return direct;
      }
      var component=String(activeActivity.component||'');
      var card=getCardFromActivity(activeActivity);
      // Do not reuse an earlier series after navigating to another page.
      if ((card && (card.id || card.tmdb_id)) ||
          (component && !/^(?:player|player-loading)$/i.test(component)))
        return null;
    }
    if(playerCreateContext && Date.now()-playerCreateContext.at<=20000 &&
       playerCreateContext.selectedId===selected.id &&
       playerCreateContext.selectedSource===selected.source)
      return playerCreateContext;
    if(lastOnlineContext && Date.now()-lastOnlineContext.at<=10000 &&
       lastOnlineContext.selectedId===selected.id &&
       lastOnlineContext.selectedSource===selected.source)
      return lastOnlineContext;
    return null;
  }

  function watchFullCard(e) {
    try {
      if (e && e.type==='complite' && e.data && e.data.movie) {
        var card=e.data.movie;
        var chosen=selectedSeries();
        lastFullCard=chosen && isSameCard(card,chosen) ?
          {at:Date.now(),selectedId:chosen.id,selectedSource:chosen.source} : null;
      }
    } catch(e){}
    addSeriesButton(e);
    openOnlinePluginFromCard(onlineRoute,e);
  }

  function onPlayerCreate(event) {
    playerCreateContext=null;
    if (!event || !event.data) return;
    var chosen=selectedSeries();
    if (!chosen) return;
    var active=detectActivityContext(chosen);
    if(active) playerCreateContext=active;
  }

  function safeStorageGet(key, otherwise) {
    try { return Lampa.Storage.get(key, otherwise); } catch(e){return otherwise;}
  }

  function providerForPlayback(data, context, selected, isTorrent) {
    if (isTorrent) return {
      provider:'TorrServer', component:'torrent', balancer:'',
      voice:'', quality:'', sourceMethod:'плеер'
    };
    var component=context ? context.component : '';
    var provider=component === 'online_mod' ? 'AT Anton Online Mod' :
      component === 'online' ? 'Lampa Online' :
      component === 'online_prestige' ? 'Lampa Online Prestige' :
      component === 'modss_online' ? 'MODS’s' :
      component ? component : 'Онлайн-плагин не определён';
    var explicit=plainLabel(data && (data.balanser || data.balancer ||
      data.provider || data.provider_name || data.service),80);
    var balancer=explicit;
    var voice=plainLabel(data && (data.voice_name || data.translate_voice ||
      data.voice || data.translation_name),100);
    var quality=plainLabel(data && (data.quality_name ||
      data.quality_selected || data.quality_switched),30);
    var sourceMethod=explicit ? 'плеер' : component ? 'текущий экран' : 'не определён';

    if(component==='online_mod'){
      var history=safeStorageGet('online_mod_last_balanser',{});
      var preferred=history && typeof history==='object' &&
        history[selected.id] || safeStorageGet('online_mod_balanser','');
      if (!balancer) balancer=plainLabel(preferred,70);
      var choices=safeStorageGet('online_mod_choice_'+preferred,{});
      var selection=choices && typeof choices==='object' ? choices[selected.id] : null;
      if (!voice && selection) voice=plainLabel(selection.voice_name,100);
    }
    else if(component==='online' || component==='online_prestige'){
      var last=safeStorageGet('online_last_balanser',{});
      if (!balancer) balancer=plainLabel((last&&last[selected.id]) ||
        safeStorageGet('online_balanser',''),70);
      var selectedB=balancer;
      var opts=safeStorageGet('online_choice_'+selectedB,{});
      var chosen=opts && typeof opts==='object' ? opts[selected.id] : null;
      if(!voice && chosen) voice=plainLabel(chosen.voice_name,100);
    }
    if(!quality && typeof (data && data.quality)==='string') 
      quality=plainLabel(data.quality,30);
    return {provider:provider,component:component,balancer:balancer,
      voice:voice,quality:quality,sourceMethod:sourceMethod};
  }

  function playbackHistory() {
    var saved=safeStorageGet(PREFIX + 'playback_history', []);
    if (!Array.isArray(saved)) return [];
    return saved.filter(function(x){return x && typeof x==='object' && x.seriesId;}).slice(0,60);
  }

  function saveHistory(item) {
    if (!item || !item.seriesId) return;
    // All fields below are intentionally plain metadata, never stream URLs or tokens.
    var obj={
      seriesId:String(item.seriesId),
      title:plainLabel(item.title,180),
      source:plainLabel(item.source,40),
      sourceType:item.sourceType==='torrent'?'torrent':'online',
      playerMode:item.playerMode==='external'?'external':'internal',
      season:numberOrNull(item.season),episode:numberOrNull(item.episode),
      episodeTitle:plainLabel(item.episodeTitle,180),
      provider:plainLabel(item.provider,90),
      providerComponent:plainLabel(item.providerComponent,90),
      balancer:plainLabel(item.balancer,90),
      voice:plainLabel(item.voice,100),
      quality:plainLabel(item.quality,30),
      matchMethod:plainLabel(item.matchMethod,80),
      episodeMethod:plainLabel(item.episodeMethod,80),
      positionSeconds:Number(item.positionSeconds)||0,
      durationSeconds:Number(item.durationSeconds)||0,
      ended:Boolean(item.ended),capturedAt:item.capturedAt
    };
    var history=playbackHistory();
    // Last record is updated on progress events rather than duplicated.
    var marker=[obj.seriesId,obj.source,obj.providerComponent,obj.balancer,
      obj.season,obj.episode,obj.episodeTitle].join('|');
    for (var i=history.length-1;i>=0;i--){
      var other=history[i];
      var candidate=[other.seriesId,other.source,other.providerComponent,
        other.balancer,other.season,other.episode,other.episodeTitle].join('|');
      if(candidate===marker){history.splice(i,1);}
    }
    history.unshift(obj);
    save('playback_history',history.slice(0,60));
  }

  function setCaptureDiagnostic(message, context) {
    var item={at:new Date().toISOString(),
      status:plainLabel(message,190),
      component:context ? plainLabel(context.component,80) : ''};
    save('capture_diagnostic',item);
  }

  function captureDiagnostic() {
    var obj=safeStorageGet(PREFIX + 'capture_diagnostic',null);
    return obj && typeof obj==='object' ? obj : null;
  }

  function matchPlayback(data, selected, context) {
    if (!data || !selected) return null;
    if (data.card && isSameCard(data.card, selected)) return 'card';
    if (data.movie && isSameCard(data.movie, selected)) return 'movie';
    // Explicit different IDs must never be overwritten by UI context.
    if ((data.card && (data.card.id || data.card.tmdb_id)) ||
        (data.movie && (data.movie.id || data.movie.tmdb_id))) return null;

    var timeline = data.timeline;
    if (timeline && typeof timeline === 'object' &&
        timeline.card && String(timeline.card) === timelineKeyForSeries(selected))
      return 'timeline';
    if (timeline && timeline.card) return null;
    if (context && context.selectedId===selected.id &&
        context.selectedSource===selected.source) return context.method;
    return null;
  }

  function episodeNumber(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 && n < 10000 && Math.floor(n) === n ? n : null;
  }

  function capturePlayback(data, mode) {
    try {
      if (!enabled('capture_playback',true)) return null;
      var selected=selectedSeries();
      if (!selected) return null;
      var context=contextForPlayback(selected);
      var match=matchPlayback(data,selected,context);
      if(!match) {
        setCaptureDiagnostic('Видео не сопоставлено с выбранным сериалом',context);
        currentPlayback=null;
        return null;
      }

      var tl=data.timeline && typeof data.timeline==='object'?data.timeline:{};
      var metadata=episodeMetadata(data,context);
      var isTorrent=Boolean(data.torrent_hash ||
        parseTorrentStreamUrl(data.url).hash);
      var provider=providerForPlayback(data,context,selected,isTorrent);
      var old=lastPlayback();
      // Preserve richer data across the internal-start / Android-external
      // pair for the same episode (the second event may omit metadata).
      // Reuse metadata only for the same stream handed off between
      // internal and external player events; never copy it to a new episode.
      var sameRecent=old && old.seriesId===selected.id &&
        old.source===selected.source &&
        old.sourceType===(isTorrent?'torrent':'online') &&
        lastRawPlayback && data &&
        Date.now()-lastRawAt<=15000 &&
        (data===lastRawPlayback ||
          (typeof data.url==='string' && data.url &&
            data.url===lastRawPlayback.url));
      if(sameRecent && !metadata.season) metadata.season=numberOrNull(old.season);
      if(sameRecent && !metadata.episode) metadata.episode=numberOrNull(old.episode);
      if (sameRecent && !provider.component) {
        provider.component=old.providerComponent || '';
        provider.provider=old.provider || provider.provider;
        provider.balancer=old.balancer || provider.balancer;
        provider.voice=old.voice || provider.voice;
      }

      var series={
        seriesId:selected.id,title:selected.title,source:selected.source,
        sourceType:isTorrent?'torrent':'online',playerMode:mode,
        matchMethod:match,episodeMethod:metadata.method,
        season:metadata.season,episode:metadata.episode,
        episodeTitle:plainLabel(data.title||data.fname||data.name||'',180),
        provider:provider.provider,
        providerComponent:provider.component,
        balancer:provider.balancer,
        voice:provider.voice,
        quality:provider.quality,
        sourceMethod:provider.sourceMethod,
        positionSeconds:Number(tl.time)>0?Math.round(Number(tl.time)):0,
        durationSeconds:Number(tl.duration)>0?Math.round(Number(tl.duration)):0,
        ended:false,capturedAt:new Date().toISOString()
      };
      currentPlayback=series;
      lastRawPlayback=data;
      lastRawAt=Date.now();
      save('last_playback',series);
      saveHistory(series);
      setCaptureDiagnostic(series.episode ?
        'Серия определена: '+(series.season?'S'+series.season+' ':'')+
          'E'+series.episode+'; '+series.provider+
          (series.balancer?' / '+series.balancer:'') :
        'Сериал распознан, но плеер не передал номер серии',context);

      if(isTorrent){
        saveTorrentIdentity(data,selected,series);
        sessionOnline=null;
      } else if(mode==='internal' && typeof data.url==='string' &&
          /^https?:\/\//i.test(data.url)) {
        // URL is only in RAM and cannot survive restarting Lampa.
        sessionOnline={seriesId:selected.id,source:selected.source,
          at:Date.now(),data:data};
      }
      log('Captured: '+series.sourceType+' / '+match+
        ' / '+series.provider+' / S'+series.season+'E'+series.episode);
      return series;
    } catch(e){
      log('Capture error: '+e.message);
      setCaptureDiagnostic('Ошибка распознавания: '+e.message,null);
      return null;
    }
  }

  function clearVideoHandlers() {
    if (!activeVideoHandlers || !Lampa.PlayerVideo ||
        !Lampa.PlayerVideo.listener) return;
    var bus = Lampa.PlayerVideo.listener;
    try {
      bus.remove('timeupdate', activeVideoHandlers.progress);
      bus.remove('ended', activeVideoHandlers.end);
    } catch (e) { log('Video cleanup error: ' + e.message); }
    activeVideoHandlers = null;
  }

  function onPlayerStart(data) {
    clearVideoHandlers();
    onLaunchPlayerStart(data);
    onOnlinePlayerStart(data);
    var observation = capturePlayback(data, 'internal');
    if (!observation || !Lampa.PlayerVideo || !Lampa.PlayerVideo.listener) return;

    var progress = function (e) {
      if (!currentPlayback || currentPlayback !== observation) return;
      var position = Number(e && e.current);
      var duration = Number(e && e.duration);
      if (!isFinite(position) || position < 0) return;
      currentPlayback.positionSeconds = Math.round(position);
      if (isFinite(duration) && duration > 0)
        currentPlayback.durationSeconds = Math.round(duration);

      var now = Date.now();
      if (now - lastProgressWrite >= 30000) {
        lastProgressWrite = now;
        save('last_playback', currentPlayback);
        saveHistory(currentPlayback);
      }
    };
    var ended = function () {
      if (!currentPlayback || currentPlayback !== observation) return;
      currentPlayback.ended = true;
      currentPlayback.positionSeconds = currentPlayback.durationSeconds;
      save('last_playback', currentPlayback);
      saveHistory(currentPlayback);
    };
    try {
      Lampa.PlayerVideo.listener.follow('timeupdate', progress);
      Lampa.PlayerVideo.listener.follow('ended', ended);
      activeVideoHandlers = { progress: progress, end: ended };
    } catch (e) { log('Video listeners error: ' + e.message); }
  }

  function onPlayerExternal(data) {
    onLaunchExternalPlayer(data);
    onOnlinePlayerExternal(data);
    clearVideoHandlers();
    capturePlayback(data, 'external');
  }

  function onPlayerDestroy() {
    onLaunchPlayerDestroy();
    onOnlinePlayerDestroy();
    if (currentPlayback && currentPlayback.playerMode === 'internal') {
      save('last_playback', currentPlayback);
      saveHistory(currentPlayback);
    }
    currentPlayback = null;
    playerCreateContext=null;
    clearVideoHandlers();
  }

  function formatPlayback(item) {
    if (!item) return 'Данных нет. Выбери сериал и запусти его обычным способом.';
    var episode = item.episode ?
      ' — S' + (item.season || '?') + 'E' + item.episode :
      ' — серия не определена';
    var source=item.sourceType==='torrent'?'TorrServer':
      (item.provider||'Онлайн');
    if(item.balancer)source+=' / '+item.balancer;
    return plainLabel(item.title,70)+episode+'; '+source+
      (item.voice?'; озвучка: '+item.voice:'')+'.';
  }

  function sourceDetails() {
    var item=lastPlayback();
    if(!item){notice('Пока нет просмотренной серии');return;}
    notice('Плагин: '+(item.provider || 'неизвестно')+
      '; балансер: '+(item.balancer||'неизвестен')+
      '; озвучка: '+(item.voice||'не определена'));
    notice('Источник определения: '+(item.matchMethod||'неизвестен')+
      '; серия: '+(item.episodeMethod||'не определена'));
  }

  function showHistory() {
    var items=playbackHistory();
    if(!items.length)return notice('История будильника пока пустая');
    if (Lampa.Select && typeof Lampa.Select.show==='function' &&
        Lampa.Controller && Lampa.Controller.enabled &&
        Lampa.Controller.toggle) {
      try{
        var controller=Lampa.Controller.enabled();
        var name=controller&&controller.name||'settings_component';
        Lampa.Select.show({
          title:'История просмотров для будильника',
          items:items.slice(0,30).map(function(x){
            return {title:formatPlayback(x),subtitle:x.capturedAt||'',record:x};
          }),
          onSelect:function(choice){
            Lampa.Controller.toggle(name);
            if(choice&&choice.record)notice(formatPlayback(choice.record));
          },
          onBack:function(){Lampa.Controller.toggle(name);}
        });
        return;
      }catch(e){log('History menu error: '+e.message);}
    }
    notice(items.slice(0,2).map(formatPlayback).join(' | '));
  }

  function captureDebugMessage() {
    var d=captureDiagnostic();
    if(!d)return 'Ещё нет диагностических событий. Запусти выбранный сериал.';
    return d.status+(d.component?' [экран '+d.component+']':'');
  }

  function clearLastPlayback() {
    save('last_playback', '');
    save('playback_history', []);
    save('capture_diagnostic', '');
    currentPlayback = null;
    notice('Будильник: история тестового воспроизведения очищена');
  }


  function manualRunPlayer(data) {
    if (!Lampa.Player || typeof Lampa.Player.play !== 'function')
      throw Error('Lampa.Player.play is unavailable');
    if (launchInProgress ||
        (typeof Lampa.Player.opened === 'function' && Lampa.Player.opened()))
      throw Error('Playback already running');
    launchInProgress = true;
    try {
      if (Lampa.Controller && typeof Lampa.Controller.toggle === 'function')
        Lampa.Controller.toggle('content');
      Lampa.Player.play(data);
      if (Lampa.Player.playlist && typeof Lampa.Player.playlist === 'function')
        Lampa.Player.playlist([data]);
    } finally {
      setTimeout(function () { launchInProgress = false; }, 4000);
    }
  }

  function canLaunchTorrent() {
    return isBookmarkCurrent(torrentBookmark(), selectedSeries());
  }

  // The TV streams media; the torrent server owns the torrent cache.
  // Launch is a finite state machine. Neither a file list nor opening an
  // external Android player alone proves that video began playing.
  function torrentWaitSeconds() {
    var n=Number(read('torrent_wait_seconds','180'));
    return n===60 || n===120 || n===180 || n===240 || n===300 ? n : 180;
  }

  function launchReport() {
    var item=storedValue('torrent_launch_status',null);
    return item && typeof item==='object' ? item : null;
  }

  function launchReportText() {
    var item=launchReport();
    if(!item)return 'TorrServer: запуск пока не проверялся';
    return 'TorrServer: '+item.message+
      (item.progressPercent!==null && typeof item.progressPercent!=='undefined' ?
        ' ('+item.progressPercent+'%)' : '')+
      '; прошло '+item.elapsedSeconds+' с'+
      (item.attempts>1?'; запросов '+item.attempts:'');
  }

  function launchState(job,stage,message,percentage) {
    if(!job || job!==torrentLaunch || job.finished)return;
    var now=Date.now();
    var pct=typeof percentage==='number'&&isFinite(percentage) ?
      Math.max(0,Math.min(100,Math.round(percentage))) : null;
    var changed=stage!==job.stage;
    job.stage=stage;
    var text=plainLabel(message,180)||'Ожидание';
    var report={
      stage:stage,message:text,progressPercent:pct,
      elapsedSeconds:Math.max(0,Math.round((now-job.startedAt)/1000)),
      attempts:job.attempts,playerMode:job.playerMode||'',
      updatedAt:new Date(now).toISOString()
    };
    job.lastReport=report;
    if(changed || now-job.lastReportAt>=4000){
      job.lastReportAt=now;
      save('torrent_launch_status',report);
    }
    if(changed) notice('TorrServer: '+text);
  }

  function launchSchedule(job,callback,delay) {
    if(!job || job.finished)return null;
    var id=setTimeout(function(){
      var index=job.timers.indexOf(id);
      if(index>=0)job.timers.splice(index,1);
      if(job.finished || job!==torrentLaunch)return;
      callback();
    },delay);
    job.timers.push(id);
    return id;
  }

  function closeLaunchListeners(job) {
    if(!job || !job.videoHandlers || !Lampa.PlayerVideo ||
       !Lampa.PlayerVideo.listener)return;
    var bus=Lampa.PlayerVideo.listener;
    try {
      bus.remove('canplay',job.videoHandlers.canplay);
      bus.remove('timeupdate',job.videoHandlers.timeupdate);
      bus.remove('error',job.videoHandlers.error);
    }catch(e){log('Launch listener cleanup error: '+e.message)}
    job.videoHandlers=null;
  }

  function completeLaunch(job,stage,message) {
    if(!job || job.finished || job!==torrentLaunch)return;
    launchState(job,stage,message,null);
    job.finished=true;
    job.timers.forEach(function(id){clearTimeout(id)});
    job.timers=[];
    if(job.preloader && typeof job.preloader.clear==='function') {
      try{job.preloader.clear()}catch(e){}
    }
    closeLaunchListeners(job);
    launchInProgress=false;
  }

  function abortTorrentLaunch() {
    if(torrentLaunch && !torrentLaunch.finished) {
      completeLaunch(torrentLaunch,'cancelled','Запуск остановлен пользователем');
    } else notice('Сейчас нет ожидающего запуска TorrServer');
  }

  function matchesTorrentLaunch(job,data) {
    if(!job || job.finished || !data)return false;
    if(data===job.playData)return true;
    var identity=torrentIdentityFromData(data);
    return identity.hash===job.bookmark.hash &&
       identity.fileIndex===job.bookmark.fileIndex;
  }

  function onLaunchPlayerStart(data) {
    var job=torrentLaunch;
    if(!matchesTorrentLaunch(job,data))return;
    job.playerMode='internal';
    launchState(job,'player_wait','Плеер открыт, ожидаю начало видео',null);
    if(!Lampa.PlayerVideo || !Lampa.PlayerVideo.listener)return;
    closeLaunchListeners(job);
    var bus=Lampa.PlayerVideo.listener;
    var handlers={
      canplay:function(){
        if(job.finished || job!==torrentLaunch)return;
        launchState(job,'canplay','Видео загружено, проверяю воспроизведение',null);
      },
      timeupdate:function(event){
        if(job.finished || job!==torrentLaunch)return;
        var position=Number(event&&event.current);
        if(isFinite(position)&&position>0.1)
          completeLaunch(job,'playing','Воспроизведение подтверждено');
      },
      error:function(event){
        if(job.finished || job!==torrentLaunch)return;
        if(event&&event.fatal)
          completeLaunch(job,'failed','Ошибка воспроизведения в плеере');
      }
    };
    job.videoHandlers=handlers;
    try{
      bus.follow('canplay',handlers.canplay);
      bus.follow('timeupdate',handlers.timeupdate);
      bus.follow('error',handlers.error);
    }catch(e){log('Player readiness monitoring error: '+e.message)}
  }

  function onLaunchExternalPlayer(data) {
    var job=torrentLaunch;
    if(!matchesTorrentLaunch(job,data))return;
    job.playerMode='external';
    // The WebView cannot confirm frames rendered in a separate Android app.
    completeLaunch(job,'external',
      'Ссылка передана внешнему плееру; запуск видео не подтверждён');
  }

  function onLaunchPlayerDestroy() {
    var job=torrentLaunch;
    if(job && !job.finished &&
        (job.stage==='player_wait'||job.stage==='canplay'||job.stage==='opening'))
      completeLaunch(job,'failed','Плеер закрыт до подтверждения воспроизведения');
  }

  function beginTorrentPlayer(job,streamUrl,file){
    if(job.finished || job!==torrentLaunch)return;
    var selected=job.series,bookmark=job.bookmark;
    var card={
      id:/^\d+$/.test(selected.id)?Number(selected.id):selected.id,
      source:selected.source,name:selected.title,title:selected.title,
      original_name:selected.originalTitle||selected.title,
      original_title:selected.originalTitle||selected.title
    };
    var data={
      url:streamUrl,
      title:bookmark.episodeTitle||file.path.split(/[\\/]/).pop(),
      card:card,movie:card,
      torrent_hash:bookmark.hash,id:bookmark.fileIndex,
      season:bookmark.season,episode:bookmark.episode
    };
    if(bookmark.season && bookmark.episode && Lampa.Timeline &&
       Lampa.Timeline.link && Lampa.Timeline.view &&
       Lampa.Utils && Lampa.Utils.hash){
      try{
        var meta=Lampa.Timeline.link(card,bookmark.season,bookmark.episode);
        var hash=Lampa.Utils.hash([bookmark.season,
          bookmark.season>10?':':'',bookmark.episode,card.original_name].join(''));
        data.timeline=Lampa.Timeline.view(hash,meta);
      }catch(e){log('Launch timeline metadata error: '+e.message)}
    }
    launchState(job,'opening','Передаю подготовленный поток плееру',null);
    job.playData=data;
    try{
      // The player wrapper has its own short lock; keep the launch job alive
      // until a player event confirms progress or the deadline is reached.
      launchInProgress=false;
      manualRunPlayer(data);
      launchSchedule(job,function(){
        if(job.stage==='opening')
          launchState(job,'player_wait','Ожидаю ответа видеоплеера',null);
      },4000);
    }catch(e){
      log('Torrent player launch error: '+e.message);
      completeLaunch(job,'failed','Не удалось открыть видеоплеер');
    }
  }

  function prebufferTorrent(job,streamUrl,file) {
    if(job.finished || job!==torrentLaunch)return;
    var shouldPreload=enabled('torrent_prebuffer',true) &&
      /&preload(?:&|$)/i.test(streamUrl) &&
      !/\.m3u8(?:\?|$)/i.test(streamUrl);
    if(!shouldPreload || typeof Lampa.Reguest!=='function'){
      beginTorrentPlayer(job,streamUrl,file);
      return;
    }
    job.preloader=new Lampa.Reguest();
    job.preloadFirst=true;
    job.preloadErrors=0;
    job.lastPercent=-1;
    launchState(job,'prebuffer','Подключаюсь к раздаче, готовлю буфер',0);
    function poll(){
      if(job.finished || job!==torrentLaunch)return;
      var initial=job.preloadFirst;
      job.preloadFirst=false;
      var url=initial?streamUrl:streamUrl.replace('&preload','&stat');
      var settled=false;
      var watchdog=launchSchedule(job,function(){
        if(settled)return;settled=true;
        retry('Нет ответа о буферизации');
      },13000);
      function once(fn){
        if(settled||job.finished)return;
        settled=true;
        if(watchdog!==null)clearTimeout(watchdog);
        fn();
      }
      function retry(reason){
        if(job.finished)return;
        job.preloadErrors++;
        if(job.preloadErrors>=3 && job.lastPercent<0){
          launchState(job,'prebuffer_fallback',
            'Статистика недоступна, запускаю плеер для буферизации',null);
          beginTorrentPlayer(job,streamUrl,file);
          return;
        }
        launchState(job,'prebuffer',
          reason+', ожидаю TorrServer',job.lastPercent>=0?job.lastPercent:0);
        launchSchedule(job,poll,2500);
      }
      try{
        job.preloader.timeout(10000);
        job.preloader.silent(url,function(stats){
          once(function(){
            var total=Number(stats&&stats.preload_size);
            var loaded=Number(stats&&stats.preloaded_bytes);
            if(!(total>0) || !isFinite(loaded)){
              // The native Lampa preloader also proceeds if no percentage
              // is available, letting the player perform normal buffering.
              launchState(job,'prebuffer_fallback',
                'Размер буфера недоступен, передаю поток плееру',null);
              beginTorrentPlayer(job,streamUrl,file);
              return;
            }
            job.preloadErrors=0;
            var percent=Math.max(0,Math.min(100,loaded*100/total));
            job.lastPercent=percent;
            if(percent>=95){
              launchState(job,'prebuffer_done','Предзагрузка завершена',100);
              beginTorrentPlayer(job,streamUrl,file);
            }else{
              launchState(job,'prebuffer',
                'Подключаюсь к раздаче, буфер '+Math.round(percent)+'%',
                percent);
              launchSchedule(job,poll,1500);
            }
          });
        },function(){
          once(function(){retry('Не удалось получить статус предзагрузки')});
        });
      }catch(e){once(function(){retry('Ошибка получения статуса буфера')})}
    }
    poll();
  }

  function retrieveTorrentFile(job) {
    if(job.finished || job!==torrentLaunch)return;
    job.attempts++;
    launchState(job,'metadata',
      'Получаю список файлов, попытка '+job.attempts,null);
    var settled=false;
    var watchdog=launchSchedule(job,function(){
      if(settled)return;
      settled=true;
      retry();
    },8500);
    function onDone(fn) {
      if(settled||job.finished)return;
      settled=true;
      if(watchdog!==null)clearTimeout(watchdog);
      fn();
    }
    function retry(){
      if(job.finished)return;
      launchSchedule(job,function(){retrieveTorrentFile(job)},2500);
    }
    try{
      Lampa.Torserver.files(job.bookmark.hash,function(response){
        onDone(function(){
          var files=response&&response.file_stats;
          if(!Array.isArray(files))return retry();
          var file=null;
          for(var i=0;i<files.length;i++){
            if(Number(files[i].id)===job.bookmark.fileIndex){
              file=files[i];break;
            }
          }
          if(!file||typeof file.path!=='string'||!file.path)
            return completeLaunch(job,'failed',
              'Сохранённый файл отсутствует в торренте');
          var streamUrl=Lampa.Torserver.stream(
            file.path,job.bookmark.hash,job.bookmark.fileIndex);
          if(typeof streamUrl!=='string'||!/^https?:\/\//i.test(streamUrl))
            return completeLaunch(job,'failed','Не удалось получить адрес потока');
          prebufferTorrent(job,streamUrl,file);
        });
      },function(){onDone(retry)});
    }catch(e){onDone(retry)}
  }

  function launchTorrentSeries() {
    var selected=selectedSeries();
    var bookmark=torrentBookmark();
    if(!isBookmarkCurrent(bookmark,selected)){
      notice(bookmarkDiagnosticMessage());return false;
    }
    if(!Lampa.Torserver ||
       typeof Lampa.Torserver.files!=='function' ||
       typeof Lampa.Torserver.stream!=='function' ||
       !Lampa.Player || typeof Lampa.Player.play!=='function'){
      notice('TorrServer API недоступен на этом устройстве');return false;
    }
    if((torrentLaunch&&!torrentLaunch.finished) || launchInProgress ||
       (Lampa.Player.opened&&Lampa.Player.opened())){
      notice('Воспроизведение уже запускается или плеер открыт');
      return false;
    }
    var job={
      startedAt:Date.now(),attempts:0,stage:'',
      finished:false,timers:[],lastReportAt:0,
      series:selected,bookmark:bookmark,playerMode:'',
      preloader:null,videoHandlers:null,playData:null
    };
    torrentLaunch=job;
    launchInProgress=true;
    launchState(job,'metadata','Подключаюсь к TorrServer',null);
    launchSchedule(job,function(){
      var message=job.stage==='metadata'?
        'Не удалось получить список файлов за '+torrentWaitSeconds()+' секунд':
        job.stage==='prebuffer'?
          'Не удалось подготовить буфер за '+torrentWaitSeconds()+' секунд':
          'Видео не начало воспроизводиться за '+torrentWaitSeconds()+' секунд';
      completeLaunch(job,'failed',message);
    },torrentWaitSeconds()*1000);
    retrieveTorrentFile(job);
    return true;
  }

  function launchOnlineSession() {
    var series = selectedSeries();
    if (!sessionOnline || !series ||
        sessionOnline.seriesId !== series.id ||
        sessionOnline.source !== series.source ||
        Date.now() - sessionOnline.at < 0 ||
        Date.now() - sessionOnline.at > ONLINE_TTL_MS) {
      notice('Онлайн: нет свежей серии в памяти. Требуется новая ссылка от плагина.');
      return false;
    }
    try {
      var data = {};
      var original = sessionOnline.data;
      for (var k in original) {
        if (Object.prototype.hasOwnProperty.call(original, k))
          data[k] = original[k];
      }
      manualRunPlayer(data);
      return true;
    } catch (e) {
      log('Online session replay failed: ' + e.message);
      notice('Онлайн-серию не удалось повторить');
      return false;
    }
  }



  // A plugin listed in Lampa's catalog isn't necessarily installed,
  // registered in the running WebView, or capable of resolving a stream.
  function knownOnlineComponents() {
    return [
      {key:'online_mod',title:'AT Anton Online Mod',kind:'online'},
      {key:'modss_online',title:'MODS’s',kind:'online'},
      {key:'online',title:'Lampa Online',kind:'online'},
      {key:'online_prestige',title:'Online Prestige',kind:'online'},
      {key:'vod',title:'Online Stream (пример)',kind:'online'},
      {key:'bwarc',title:'BWA (пример)',kind:'online'}
    ];
  }

  function observedOnlineComponents() {
    var items=safeStorageGet(PREFIX+'online_components_seen',[]);
    if(!Array.isArray(items))return [];
    return items.filter(function(x){
      return x && typeof x==='object' &&
        /^[a-z][a-z0-9_-]{0,50}$/i.test(x.key||'') &&
        sourceComponentIsOnline(x.key);
    }).slice(0,25);
  }

  function observeOnlineActivity(event){
    if(!event || event.type!=='start'||!event.object)return;
    var component=String(event.object.component||'');
    if(!/^[a-z][a-z0-9_-]{0,50}$/i.test(component) ||
       !sourceComponentIsOnline(component))return;
    var items=observedOnlineComponents().filter(function(x){
      return x.key!==component;
    });
    items.unshift({key:component,title:component,
      lastOpen:new Date().toISOString()});
    save('online_components_seen',items.slice(0,25));
  }

  function onlineComponentInventory(){
    var entries=knownOnlineComponents();
    observedOnlineComponents().forEach(function(x){
      if(!entries.some(function(e){return e.key===x.key}))
        entries.push({key:x.key,title:x.key,kind:'online'});
    });
    var history=playbackHistory();
    history.forEach(function(x){
      var component=String(x.providerComponent||'');
      if(x.sourceType==='online' &&
         /^[a-z][a-z0-9_-]{0,50}$/i.test(component) &&
         sourceComponentIsOnline(component) &&
         !entries.some(function(e){return e.key===component})){
        entries.push({key:component,title:plainLabel(x.provider,80)||
          component,kind:'online'});
      }
    });
    var observed=observedOnlineComponents();
    return entries.map(function(e){
      var registered=false;
      try{
        registered=Boolean(Lampa.Component &&
          typeof Lampa.Component.get==='function' &&
          Lampa.Component.get(e.key));
      }catch(error){}
      var visited=observed.some(function(v){return v.key===e.key});
      var inHistory=history.some(function(v){
        return v.sourceType==='online' &&
          v.providerComponent===e.key;
      });
      return {component:e.key,name:e.title,
        registered:registered,visited:visited,seenInHistory:inHistory};
    });
  }

  function showOnlineInventory(){
    var entries=onlineComponentInventory();
    if(Lampa.Select && typeof Lampa.Select.show==='function'){
      try{
        var controller=Lampa.Controller && Lampa.Controller.enabled ?
          Lampa.Controller.enabled():null;
        var back=controller && controller.name || 'settings_component';
        Lampa.Select.show({
          title:'Онлайн-компоненты Lampa',
          items:entries.map(function(x){
            return {
              title:x.name,
              subtitle:(x.registered?'Зарегистрирован':'Регистрация не подтверждена')+
                (x.visited?' • открывался':'')+
                (x.seenInHistory?' • есть история просмотра':'')+
                ' • '+x.component
            };
          }),
          onSelect:function(x){notice(x.title+': '+x.subtitle);},
          onBack:function(){
            if(Lampa.Controller && Lampa.Controller.toggle)
              Lampa.Controller.toggle(back);
          }
        });
        return;
      }catch(e){log('Online inventory dialog failed: '+e.message);}
    }
    notice(entries.map(function(e){
      return e.name+': '+(e.registered?'зарегистрирован':'не подтверждён');
    }).join(' | '));
  }

  // Online replay uses the installed plugin's OWN episode selection button.
  // It must not try to reuse saved stream URLs after restarting Lampa.
  function onlineReplayCandidate(){
    var selected=selectedSeries();
    if(!selected)return null;
    var history=playbackHistory();
    var recent=lastPlayback();
    if(recent && recent.sourceType==='online')history.unshift(recent);
    for(var i=0;i<history.length;i++){
      var row=history[i];
      if(row && row.sourceType==='online' &&
         String(row.seriesId)===selected.id &&
         String(row.source)===selected.source){
        var component=plainLabel(row.providerComponent,50);
        return {
          id:selected.id,source:selected.source,title:selected.title,
          originalTitle:selected.originalTitle,
          component:component,provider:plainLabel(row.provider,100),
          balancer:plainLabel(row.balancer,70),
          voice:plainLabel(row.voice,90),
          season:numberOrNull(row.season),episode:numberOrNull(row.episode),
          capturedAt:row.capturedAt||''
        };
      }
    }
    return null;
  }

  function onlineComponentSupported(component){
    if(!/^[a-z][a-z0-9_-]{0,50}$/i.test(component||''))return false;
    if(component==='online_mod' || component==='modss_online' ||
       component==='online' || component==='online_prestige')return true;
    // Other installed online providers may follow the same list conventions.
    // Only use a named component registered by Lampa, never an unknown one.
    return Boolean(sourceComponentIsOnline(component) &&
      Lampa.Component && typeof Lampa.Component.get==='function' &&
      Lampa.Component.get(component));
  }

  function onlineStatus(){
    var data=storedValue('online_launch_status',null);
    return data && typeof data==='object' ? data : null;
  }

  function onlineStatusText(){
    var state=onlineStatus();
    if(!state)return 'Онлайн: тест повторного открытия ещё не запускался';
    return 'Онлайн: '+state.message+'; прошло '+state.elapsedSeconds+' с';
  }

  function onlineRecordState(job, stage, message) {
    if(!job || job!==onlineRoute || job.finished)return;
    var stageChanged=job.stage!==stage;
    job.stage=stage;
    var now=Date.now();
    var status={
      stage:stage,message:plainLabel(message,190),
      elapsedSeconds:Math.max(0,Math.round((now-job.startedAt)/1000)),
      provider:plainLabel(job.route.provider,90),
      component:job.route.component,
      balancer:plainLabel(job.route.balancer,70),
      season:job.route.season,episode:job.route.episode,
      updatedAt:new Date(now).toISOString()
    };
    if(stageChanged || now-job.lastSaveAt>=4000) {
      job.lastSaveAt=now;
      save('online_launch_status',status);
    }
    if(stageChanged) notice('Онлайн: '+status.message);
  }

  function onlineTimer(job, callback, delay){
    if(job.finished || job!==onlineRoute)return null;
    var id=setTimeout(function(){
      var i=job.timers.indexOf(id);
      if(i>=0)job.timers.splice(i,1);
      if(job.finished || job!==onlineRoute)return;
      callback();
    },delay);
    job.timers.push(id);
    return id;
  }

  function detachOnlineVideo(job){
    if(!job || !job.videoCallbacks ||
       !Lampa.PlayerVideo || !Lampa.PlayerVideo.listener)return;
    var bus=Lampa.PlayerVideo.listener;
    var handlers=job.videoCallbacks;
    try{
      bus.remove('timeupdate',handlers.timeupdate);
      bus.remove('error',handlers.error);
    }catch(e){}
    job.videoCallbacks=null;
  }

  function onlineFinish(job,stage,message){
    if(!job || job!==onlineRoute || job.finished)return;
    onlineRecordState(job,stage,message);
    job.finished=true;
    job.timers.forEach(function(id){clearTimeout(id)});
    job.timers=[];
    detachOnlineVideo(job);
  }

  function cancelOnlineRoute(){
    if(onlineRoute && !onlineRoute.finished)
      onlineFinish(onlineRoute,'cancelled','Тест онлайн-воспроизведения отменён');
    else notice('Онлайн: нет активного теста');
  }

  function prepareOnlineBalancer(job){
    var route=job.route;
    if(!/^[a-z][a-z0-9_-]{0,48}$/i.test(route.balancer||''))return;
    try{
      var key,historyKey;
      if(route.component==='online_mod'){
        key='online_mod_balanser';
        historyKey='online_mod_last_balanser';
      }else if(route.component==='online' ||
               route.component==='online_prestige'){
        key='online_balanser';
        historyKey='online_last_balanser';
      }else return;
      // Reapply the user's previously used balancer for this series.
      // The original plugin still selects its own voice/quality preferences.
      Lampa.Storage.set(key,route.balancer);
      var map=safeStorageGet(historyKey,{});
      if(!map || typeof map!=='object'||Array.isArray(map))map={};
      map[job.series.id]=route.balancer;
      Lampa.Storage.set(historyKey,map);
    }catch(e){log('Restore online balancer failed: '+e.message);}
  }

  function onlineActivityMatches(job,activity){
    if(!job || !activity || activity.component!==job.route.component)return false;
    var card=getCardFromActivity(activity);
    return Boolean(card && isSameCard(card,job.series));
  }

  function onOnlineListReady(job,activity){
    if(job.finished || job!==onlineRoute)return;
    if(!onlineActivityMatches(job,activity)){
      onlineFinish(job,'failed','Сторонний плагин открыл другую карточку');
      return;
    }
    if(!job.auto){
      onlineFinish(job,'opened',
        'Экран источника открыт. Выбери серию вручную');
      return;
    }
    if(!job.route.season || !job.route.episode){
      onlineFinish(job,'manual',
        'Сезон или серия не сохранены; выбирай эпизод вручную');
      return;
    }
    onlineRecordState(job,'waiting_rows',
      'Жду список эпизодов S'+job.route.season+'E'+job.route.episode);
    onlineTimer(job,function(){onlineFindEpisodeRow(job)},800);
  }


  // MODS's displays "S1:E1" as a badge on the thumbnail while the
  // episode name (e.g., "Требуется помощник") is a separate title.
  // Only parse metadata from within one episode row, never neighboring rows.
  function episodeRowText(item, selector) {
    try {
      var child=item.find(selector);
      if(child && child.length && typeof child.text==='function')
        return plainLabel(child.text(),240);
      if(child && child.length && typeof child.first==='function' &&
         typeof child.first().text==='function')
        return plainLabel(child.first().text(),240);
    }catch(e){}
    return '';
  }

  function safeRowAttribute(item,key) {
    try {
      if(item && typeof item.attr==='function'){
        var val=item.attr(key);
        return typeof val==='string' && val.length<=140 ? val : '';
      }
    }catch(e){}
    return '';
  }

  function inspectEpisodeRow(item, isModss) {
    var title=episodeRowText(item,isModss?
      '.online_modss__title':'.online__title');
    var detail=episodeRowText(item,isModss?
      '.online_modss__quality':'.online__quality');
    var dataSeason=null, dataEpisode=null;
    var pairs=[
      ['data-season','data-episode'],
      ['data-season-number','data-episode-number'],
      ['data-s','data-e']
    ];
    // jQuery data() may expose an episode object added by a third-party plugin.
    try{
      var node=item && item.length && item[0] || null;
      for(var j=0;j<pairs.length;j++){
        var season=safeRowAttribute(item,pairs[j][0]);
        var episode=safeRowAttribute(item,pairs[j][1]);
        if(node && node.getAttribute) {
          season=season||node.getAttribute(pairs[j][0]);
          episode=episode||node.getAttribute(pairs[j][1]);
        }
        if(numberOrNull(season)&&numberOrNull(episode)){
          dataSeason=numberOrNull(season);
          dataEpisode=numberOrNull(episode);
          break;
        }
      }
      if(!dataSeason && node && node.dataset){
        dataSeason=numberOrNull(node.dataset.season || node.dataset.seasonNumber);
        dataEpisode=numberOrNull(node.dataset.episode || node.dataset.episodeNumber);
      }
      if((!dataSeason||!dataEpisode)&&item && typeof item.data==='function'){
        dataSeason=dataSeason||numberOrNull(item.data('season'));
        dataEpisode=dataEpisode||numberOrNull(item.data('episode'));
      }
    }catch(e){log('Online episode attributes unavailable: '+e.message);}
    if(dataSeason && dataEpisode)
      return {title:title,detail:detail,season:dataSeason,
        episode:dataEpisode,method:'атрибуты карточки'};

    // Prefer the thumbnail region: the badge S1:E1 often lives here.
    var sources=isModss?[
      ['.online_modss__img','метка на постере'],
      ['.online_modss__img .online_modss__season','номер на постере'],
      ['.online_modss__img .online_modss__episode','номер на постере'],
      ['.online_modss__img [data-episode]','атрибут миниатюры'],
      ['.online_modss__badge','бейдж'],
      ['.online_modss__mark','метка'],
      ['.online_modss__info','данные карточки'],
      ['.online_modss__title','название'],
      ['.online_modss__head','верхняя строка'],
      ['.online_modss__body','описание']
    ]:[
      ['.online__title','название'],
      ['.online__body','описание']
    ];
    for(var i=0;i<sources.length;i++){
      var label=episodeRowText(item,sources[i][0]);
      var ep=extractEpisodeFromTitle(label);
      if(ep.season && ep.episode)
        return {title:title,detail:detail,season:ep.season,
          episode:ep.episode,method:sources[i][1]};
    }
    // Reading the whole row is important when the title contains only the
    // episode name, but a sibling contains the season/episode badge.
    var text='';
    try{if(item && typeof item.text==='function')text=plainLabel(item.text(),480)}catch(e){}
    var parsed=extractEpisodeFromTitle(text);
    if(parsed.season && parsed.episode)
      return {title:title,detail:detail,season:parsed.season,
        episode:parsed.episode,method:'полный текст строки'};

    // Some Lampa themes put the number in a tooltip/ARIA label.
    var attrNames=['title','aria-label','data-label','data-title'];
    for(var k=0;k<attrNames.length;k++){
      var attr=safeRowAttribute(item,attrNames[k]);
      var fromAttr=extractEpisodeFromTitle(attr);
      if(fromAttr.season && fromAttr.episode)
        return {title:title,detail:detail,season:fromAttr.season,
          episode:fromAttr.episode,method:'подпись элемента'};
    }
    var sample=plainLabel(text||title,140);
    return {title:title,detail:detail,season:null,episode:null,
      method:'неизвестен',sample:sample};
  }

  function onlineRowDiagnostics() {
    var report=storedValue('online_rows_diag',null);
    return report && typeof report==='object' ? report : null;
  }

  function onlineRowDiagnosticsText() {
    var data=onlineRowDiagnostics();
    if(!data)return 'Нет данных о строках онлайн-парсера. Запусти тест выбора серии.';
    return plainLabel(data.component,40)+
      ': строк '+data.total+
      ', распознано номеров '+data.numbered+
      ', совпадений '+data.matched+
      (data.samples && data.samples.length ?
        '. Примеры: '+data.samples.join(' | ') : '');
  }

  function findEpisodeCandidates(job,activity){
    var result=[];
    var root=activity.activity && typeof activity.activity.render==='function' ?
      activity.activity.render() : null;
    if(!root || typeof root.find!=='function')return result;
    var isModss=job.route.component==='modss_online';
    var list=root.find(isModss ?
      '.online_modss.selector, .online_modss--full.selector' : '.online.selector');
    if(isModss && (!list || !list.length))
      list=root.find('.online_modss, .online_modss--full');
    if(!list || typeof list.each!=='function')return result;
    var count=0,parsedCount=0,examples=[],sampled=0;
    list.each(function(index,element){
      if(count++>=500)return;
      try{
        var item=$(element);
        var row=inspectEpisodeRow(item,isModss);
        if(row.season && row.episode)parsedCount++;
        if(examples.length<4)examples.push(
          row.season && row.episode ?
            'S'+row.season+'E'+row.episode+' ['+row.method+']':
            (plainLabel(row.title||row.sample,45)||'без названия')+
            ' [номер не найден]');
        if(row.season===job.route.season &&
           row.episode===job.route.episode){
          result.push({item:item,title:plainLabel(row.title,170),
            detail:plainLabel(row.detail,180),method:row.method});
        }
      }catch(e){log('Online row read error: '+e.message);}
    });
    job.rowCount=count;
    job.rowParsed=parsedCount;
    job.rowMatches=result.length;
    if(Date.now()-(job.lastRowReport||0)>4500 || job.lastRowReport===0){
      job.lastRowReport=Date.now();
      save('online_rows_diag',{
        component:job.route.component,
        total:count,numbered:parsedCount,matched:result.length,
        samples:examples,at:new Date().toISOString()
      });
    }
    return result;
  }

  function onlineFindEpisodeRow(job){
    if(job.finished || job!==onlineRoute || job.stage!=='waiting_rows')return;
    var activity;
    try{activity=Lampa.Activity.active()}catch(e){}
    if(!onlineActivityMatches(job,activity)){
      onlineFinish(job,'cancelled','Экран онлайн-сериала закрыт или заменён');
      return;
    }
    var rows=findEpisodeCandidates(job,activity);
    if(rows.length){
      var chosen=null;
      if(rows.length===1)chosen=rows[0];
      else if(job.route.voice){
        var voice=job.route.voice.toLocaleLowerCase();
        var exactVoice=rows.filter(function(row){
          return row.detail.toLocaleLowerCase().indexOf(voice)>=0;
        });
        if(exactVoice.length===1)chosen=exactVoice[0];
      }
      if(!chosen){
        onlineFinish(job,'manual',
          'Найдено несколько вариантов серии; выбери нужную озвучку вручную');
        return;
      }
      // A single matching episode can still have a different voice from the
      // saved choice if filters changed. Never auto-play a visibly mismatched dub.
      if(job.route.voice && chosen.detail &&
         /(?:\/|озвуч|перевод|voice|dub)/i.test(chosen.detail) &&
         chosen.detail.toLocaleLowerCase().indexOf(
           job.route.voice.toLocaleLowerCase())<0){
        onlineFinish(job,'manual',
          'Озвучка отличается от сохранённой; проверь выбор вручную');
        return;
      }
      if(!chosen.item || typeof chosen.item.trigger!=='function'){
        onlineFinish(job,'manual',
          'Не удалось нажать на строку серии; выбери её вручную');
        return;
      }
      try{
        job.clicked=true;
        onlineRecordState(job,'launching',
          'Выбрана S'+job.route.season+'E'+job.route.episode+
          ', ожидаю плеер');
        chosen.item.trigger('hover:enter');
      }catch(e){
        log('Online row activation failed: '+e.message);
        onlineFinish(job,'manual',
          'Не удалось запустить строку плагина. Выбери серию вручную');
      }
      return;
    }
    // State is updated periodically, without spamming notifications.
    if(Date.now()-(job.lastProgressMessage||0)>=5000){
      job.lastProgressMessage=Date.now();
      if(job.rowCount){
        onlineRecordState(job,'waiting_rows',
          'В списке '+job.rowCount+' строк, прочитано номеров '+
          job.rowParsed+'. Ищу S'+job.route.season+'E'+job.route.episode);
      }else{
        onlineRecordState(job,'waiting_rows',
          'Список эпизодов пока загружается');
      }
    }
    onlineTimer(job,function(){onlineFindEpisodeRow(job)},1400);
  }

  function onOnlineActivityEvent(e){
    var job=onlineRoute;
    if(!job || job.finished || !e || e.type!=='start')return;
    if(job.stage==='waiting_source' &&
       onlineActivityMatches(job,e.object)){
      onlineRecordState(job,'source_open','Источник открыт, загружаю эпизоды');
      onlineTimer(job,function(){
        if(job.finished)return;
        onOnlineListReady(job,e.object);
      },500);
    }
  }

  function openOnlinePluginFromCard(job,event){
    if(job.finished || job!==onlineRoute || job.stage!=='card_wait')return;
    if(!event || event.type!=='complite'||!event.data ||
       !event.data.movie||!isSameCard(event.data.movie,job.series))return;
    onlineRecordState(job,'source_select','Ищу кнопку сохранённого онлайн-плагина');
    onlineTimer(job,function(){
      if(job.finished)return;
      try{
        var comp=job.route.component;
        var root=event.object && event.object.activity &&
          event.object.activity.render();
        var selector=comp==='online_mod' ?
          '.view--online_mod' :
          (comp==='online'||comp==='online_prestige') ?
          '.view--online' : '.view--'+comp;
        var buttons=root && root.find ? root.find(selector) : null;
        prepareOnlineBalancer(job);
        // Normal Online and Prestige can share the same button CSS class.
        // Never trigger an ambiguous button belonging to the wrong plugin.
        var safeButton=buttons && buttons.length===1 &&
          (comp!=='online_prestige'||!Lampa.Component ||
            !Lampa.Component.get ||
            !Lampa.Component.get('online'));
        onlineRecordState(job,'waiting_source','Открываю сохранённый онлайн-источник');
        if(safeButton && typeof buttons.first==='function'){
          buttons.first().trigger('hover:enter');
          return;
        }
        // Fallback: start only an explicitly registered component.
        if(Lampa.Component && typeof Lampa.Component.get==='function' &&
           Lampa.Component.get(comp) &&
           Lampa.Activity && typeof Lampa.Activity.push==='function'){
          var full=event.data.movie;
          Lampa.Activity.push({
            url:'',title:plainLabel(job.route.provider,100)||'Онлайн',
            component:comp,search:full.title||full.name,
            search_one:full.title||full.name,
            search_two:full.original_title||full.original_name,
            movie:full,page:1
          });
          return;
        }
        onlineFinish(job,'manual',
          'Не удалось открыть плагин автоматически — выбери онлайн-кнопку в карточке');
      }catch(e){
        log('Open online provider error: '+e.message);
        onlineFinish(job,'manual',
          'Не удалось открыть источник автоматически. Выбери его вручную');
      }
    },250);
  }

  function isExpectedOnlinePlayback(job,data){
    if(!job || job.finished || !job.clicked || !data)return false;
    if(data.torrent_hash)return false;
    var card=data.movie||data.card;
    if(card && (card.id||card.tmdb_id) &&
       !isSameCard(card,job.series))return false;
    var tl=data.timeline;
    if(tl && tl.card && String(tl.card)!==timelineKeyForSeries(job.series))
      return false;
    var episode=episodeMetadata(data);
    if(episode.season && episode.season!==job.route.season)return false;
    if(episode.episode && episode.episode!==job.route.episode)return false;
    return true;
  }

  function onOnlinePlayerStart(data){
    var job=onlineRoute;
    if(!job || job.finished || job.stage!=='launching' ||
       !isExpectedOnlinePlayback(job,data))return;
    onlineRecordState(job,'player_wait','Плеер открыт, проверяю начало видео');
    if(!Lampa.PlayerVideo || !Lampa.PlayerVideo.listener)return;
    var bus=Lampa.PlayerVideo.listener;
    detachOnlineVideo(job);
    var cb={
      timeupdate:function(event){
        var pos=Number(event && event.current);
        if(isFinite(pos)&&pos>0.1)
          onlineFinish(job,'playing',
            'Онлайн-видео воспроизводится. S'+job.route.season+
            'E'+job.route.episode);
      },
      error:function(event){
        if(event && event.fatal)
          onlineFinish(job,'failed','Плеер сообщил об ошибке онлайн-видео');
      }
    };
    job.videoCallbacks=cb;
    try{
      bus.follow('timeupdate',cb.timeupdate);
      bus.follow('error',cb.error);
    }catch(e){log('Online player observer failed: '+e.message);}
  }

  function onOnlinePlayerExternal(data){
    var job=onlineRoute;
    if(!job || job.finished || job.stage!=='launching' ||
       !isExpectedOnlinePlayback(job,data))return;
    onlineFinish(job,'external',
      'Серия передана внешнему плееру; воспроизведение не подтверждено');
  }

  function onOnlinePlayerDestroy(){
    var job=onlineRoute;
    if(job && !job.finished &&
       (job.stage==='launching'||job.stage==='player_wait'))
      onlineFinish(job,'failed','Плеер закрыт до подтверждения воспроизведения');
  }

  function startOnlineReplay(automatic){
    if(onlineRoute && !onlineRoute.finished){
      notice('Онлайн: предыдущий тест ещё выполняется');return false;
    }
    if(torrentLaunch && !torrentLaunch.finished){
      notice('Сначала заверши подготовку TorrServer');return false;
    }
    if(Lampa.Player && Lampa.Player.opened && Lampa.Player.opened()){
      notice('Сначала закрой текущий видеоплеер');return false;
    }
    var selected=selectedSeries();
    var route=onlineReplayCandidate();
    if(!selected || !route){
      notice('Нет сохранённого онлайн-просмотра для выбранного сериала');
      return false;
    }
    if(!onlineComponentSupported(route.component)){
      notice('Источник '+(route.provider||route.component)+
        ' пока требует отдельного адаптера');
      return false;
    }
    if(!Lampa.Activity || typeof Lampa.Activity.push!=='function'){
      notice('Lampa не предоставляет доступ к открытию карточки');return false;
    }
    var job={
      startedAt:Date.now(),lastSaveAt:0,stage:'',finished:false,
      timers:[],series:selected,route:route,
      auto:Boolean(automatic),clicked:false,videoCallbacks:null
    };
    onlineRoute=job;
    onlineRecordState(job,'card_wait',
      'Открываю карточку '+selected.title);
    onlineTimer(job,function(){
      onlineFinish(job,'failed',
        'Источник не завершил загрузку за 120 секунд');
    },120000);
    try{
      if(Lampa.Controller && typeof Lampa.Controller.toggle==='function')
        Lampa.Controller.toggle('content');
      Lampa.Activity.push({
        url:'',title:selected.title,
        component:'full',id:/^\d+$/.test(selected.id)?
          Number(selected.id):selected.id,
        source:selected.source,method:'tv',
        card:{id:/^\d+$/.test(selected.id)?Number(selected.id):selected.id,
          source:selected.source,name:selected.title,title:selected.title,
          original_name:selected.originalTitle||selected.title,
          original_title:selected.originalTitle||selected.title},
        page:1
      });
      return true;
    }catch(e){
      log('Online card opening failed: '+e.message);
      onlineFinish(job,'failed','Ошибка открытия карточки сериала');
      return false;
    }
  }


  function armOneShotTest(value) {
    if (!(value === true || String(value) === 'true')) {
      save('startup_test_enabled', false);
      save('startup_test_origin', '');
      notice('Тест после запуска отменён');
      return;
    }
    if (!canLaunchTorrent()) {
      save('startup_test_enabled', false);
      notice(bookmarkDiagnosticMessage());
      return;
    }
    save('startup_test_enabled', true);
    save('startup_test_origin', startupSessionId);
    save('startup_test_series', selectedSeries().source + ':' + selectedSeries().id);
    save('startup_test_armed_at', Date.now());
    startupTestTriggered = false;
    notice('Тест подготовлен. Выключи TV, подожди 30 секунд и включи обратно.');
    log('One-shot startup test armed');
  }

  function testStatus() {
    var state = enabled('startup_test_enabled', false);
    var book = torrentBookmark();
    var series = selectedSeries();
    if (!state) {
      notice(isBookmarkCurrent(book, series) ?
        'Тест отключён. Сохранённая серия TorrServer готова.' :
        bookmarkDiagnosticMessage());
    } else {
      notice('Тест ожидает следующего запуска или пробуждения Lampa.');
    }
  }

  function tryArmedStartupTest(reason, inactiveMs) {
    if (startupTestTriggered || !enabled('startup_test_enabled', false))
      return false;
    if (reason === 'новый запуск' &&
        storedValue('startup_test_origin', '') === startupSessionId)
      return false; // Never run immediately when the user checks the toggle.
    if (reason !== 'новый запуск' && inactiveMs < 10000)
      return false;

    startupTestTriggered = true;
    save('startup_test_enabled', false); // One-shot, consume before attempting.
    save('startup_test_origin', '');

    var selected = selectedSeries();
    if (!selected ||
        storedValue('startup_test_series', '') !==
        (selected.source + ':' + selected.id)) {
      notice('Тест отменён: выбранный сериал изменился');
      return true;
    }
    notice('Будильник: пробую запустить серию после ' + reason);
    setTimeout(function () { launchTorrentSeries(); }, 2500);
    return true;
  }

  function settingsSnapshot() {
    var dayValues = [];
    for (var i = 0; i < 7; i++) {
      if (enabled('day_' + i, true)) dayValues.push(i);
    }
    return {
      version: VERSION,
      enabled: enabled('enabled', false),
      time: String(read('time', '07:00')),
      days: dayValues,
      source: String(read('source', 'last')),
      episode: String(read('episode', 'resume')),
      volumeMode: String(read('volume_mode', 'previous')),
      startFractionPercent: Number(read('start_fraction', '15')),
      maxVolumePercent: Number(read('max_volume', '20')),
      rampMinutes: Number(read('ramp_minutes', '10')),
      lastRun: String(read('last_run', '')),
      wakeOnly: enabled('wake_only', false),
      minSleepMinutes: Number(read('min_sleep', '30')),
      wakeWindowMinutes: Number(read('wake_window', '3')),
      lastWakeInfo: String(read('last_wake_info', 'не обнаружено')),
      selectedSeries: selectedSeries(),
      lastPlayback: lastPlayback(),
      historyCount: playbackHistory().length,
      captureDiagnostic: captureDiagnostic(),
      torrentBookmark: torrentBookmark() ?
        { season: torrentBookmark().season, episode: torrentBookmark().episode,
          fileIndex: torrentBookmark().fileIndex, savedAt: torrentBookmark().savedAt } : null,
      startupTestEnabled: enabled('startup_test_enabled', false),
      torrentBookmarkStatus: bookmarkDiagnosticMessage(),
      torrentLaunchStatus: launchReport(),
      onlineLaunchStatus: onlineStatus(),
      onlineReplayCandidate: onlineReplayCandidate()
    };
  }
  function checkSchedule() {
    try {
      var data = settingsSnapshot();
      if (!data.enabled) return;
      var now = new Date();
      var scheduled = timeMinutes(data.time);
      if (scheduled < 0 || data.days.indexOf(now.getDay()) < 0) return;
      var minute = now.getHours() * 60 + now.getMinutes();
      // Allow ten minutes for Lampa to resume after TV power-on, not all day.
      var allowedDelay = data.wakeOnly ? data.wakeWindowMinutes : 10;
      if (minute < scheduled || minute > scheduled + allowedDelay) return;
      var key = keyForDate(now);
      if (data.wakeOnly) {
        // A fresh opening of Lampa at 07:00 is NOT evidence that the TV woke.
        // JavaScript cannot distinguish a TV wake from returning from another app.
        if (!wakeObservation) return;
        var scheduledAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
          Math.floor(scheduled / 60), scheduled % 60).getTime();
        var windowMs = allowedDelay * 60000;
        if (Math.abs(wakeObservation.at - scheduledAt) > windowMs ||
            now.getTime() - wakeObservation.at > windowMs ||
            lastInteractionAt >= wakeObservation.at) return;
      }
      if (data.lastRun === key) return;
      save('last_run', key);
      notice('Lampa Alarm: время будильника ' + data.time + '. Видео и громкость подключим в следующей версии.');
      log('Schedule fired: ' + key + ' ' + data.time);
    } catch (e) {
      log('Schedule error: ' + e.message);
    }
  }
  function addParam(name, type, label, description, defaultValue, values, callback) {
    var param = { name: PREFIX + name, type: type, 'default': defaultValue };
    // Lampa Params.update() expects a string mapping for input fields.
    // Without it, some versions throw while opening the settings screen.
    if (type === 'input') param.values = values == null ? '' : values;
    else if (values) param.values = values;
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: param,
      field: { name: label, description: description || '' },
      onChange: callback || function () {}
    });
  }
  function addTitle(label) {
    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { type: 'title' },
      field: { name: label }
    });
  }
  function setupSettings() {
    Lampa.SettingsApi.addComponent({
      component: COMPONENT,
      name: 'Будильник',
      icon: ICON
    });

    addTitle('Расписание');
    addParam('enabled', 'trigger', 'Будильник включён',
      'Проверка времени работает только пока Lampa запущена или возобновила работу.', false);
    addParam('time', 'input', 'Время запуска (ЧЧ:ММ)',
      'Например, 07:00. Если время некорректно, срабатывание блокируется.', '07:00', null,
      function (value) {
        if (timeMinutes(value) < 0) notice('Будильник: укажи время в формате 07:00');
      });
    addTitle('Дни недели');
    for (var i = 0; i < weekdays.length; i++) {
      (function (day) {
        addParam('day_' + day.id, 'trigger', day.title, 'Запускать будильник в этот день.', true);
      })(weekdays[i]);
    }

    addTitle('Защита от случайного запуска (эксперимент)');
    addParam('wake_only', 'trigger', 'Только после пробуждения',
      'Сработает лишь если Lampa заметила долгую паузу и возобновление. ' +
      'Не всегда распознаёт включение TV. По умолчанию выключено.', false);
    addParam('min_sleep', 'select', 'Минимальный простой',
      'Не менее скольких минут Lampa должна быть неактивна.', '30',
      { '15': '15 минут', '30': '30 минут', '60': '1 час' });
    addParam('wake_window', 'select', 'Окно после пробуждения',
      'Как близко к времени будильника должно произойти возобновление Lampa.', '3',
      { '1': '1 минута', '3': '3 минуты', '5': '5 минут' });
    addParam('wake_status', 'button', 'Проверить обнаружение сна',
      'Показывает последний обнаруженный в этой сессии длительный простой.', '', null,
      function () { notice(wakeStatusText()); });

    addTitle('Сериал');
    addParam('card_button', 'trigger', 'Кнопка «В будильник» в карточках',
      'Показывать кнопку на страницах сериалов.', true);

    Lampa.SettingsApi.addParam({
      component: COMPONENT,
      param: { type: 'static' },
      field: { name: 'Выбранный сериал',
        description: 'Выбери сериал через кнопку «В будильник» на его карточке.' },
      onRender: function (item) {
        var current = selectedSeries();
        item.find('.settings-param__name').text(current ?
          'Сериал: ' + current.title : 'Сериал пока не выбран');
        if (current) item.find('.settings-param__descr').text(
          'Источник карточки: ' + current.source + ', ID: ' + current.id);
      }
    });
    addParam('series_info', 'button', 'Показать выбранный сериал',
      'Показать название и источник сохранённой карточки.', '', null,
      function () {
        var chosen = selectedSeries();
        notice(chosen ? 'Выбран: ' + chosen.title + ' (' + chosen.source + ')' :
          'Будильник: сериал ещё не выбран');
      });
    addParam('series_clear', 'button', 'Сбросить выбранный сериал',
      'После сброса выбери новый сериал в карточке.', '', null, clearSelectedSeries);

    addTitle('Последнее воспроизведение');
    addParam('capture_playback', 'trigger', 'Запоминать воспроизведение сериала',
      'Сохранять только тип источника, сезон, серию и позицию. Без URL и токенов.', true);
    addParam('playback_info', 'button', 'Последняя просмотренная серия',
      'Показать обнаруженную серию выбранного сериала.', '', null,
      function () { notice(formatPlayback(lastPlayback())); });
    addParam('playback_source', 'button', 'Источник и озвучка последней серии',
      'Показывает плагин, балансер и происхождение данных.', '', null,
      sourceDetails);
    addParam('playback_history', 'button', 'История просмотров будильника',
      'До 60 последних записей с номерами серий и источниками.', '', null,
      showHistory);
    addParam('playback_debug', 'button', 'Диагностика распознавания серии',
      'Показывает, что удалось распознать, без ссылок и токенов.', '', null,
      function(){notice(captureDebugMessage());});
    addParam('playback_clear', 'button', 'Очистить историю будильника',
      'Удалить запись о последней серии, не затрагивая историю Lampa.', '', null,
      clearLastPlayback);

    addTitle('Планируемое воспроизведение (пока не активно)');
    addParam('source', 'select', 'Источник серии',
      'Сохранение предпочтения: воспроизведение подключим позже.', 'last',
      { last: 'Последний источник', online: 'Онлайн', torrent: 'TorrServer' });
    addParam('episode', 'select', 'Серия',
      'Сохранение предпочтения: поиск серии подключим позже.', 'resume',
      { resume: 'Продолжить', next: 'Следующая непросмотренная', repeat: 'Повторить последнюю' });

    addTitle('Плавная громкость (пока не активно)');
    addParam('volume_mode', 'select', 'Конечная громкость',
      'Настройка на будущее. На Android громкость пока не меняем.', 'previous',
      { previous: 'Прошлая, но не выше лимита', fixed: 'Ровно заданный предел' });
    addParam('start_fraction', 'select', 'Начало: доля от конечной громкости',
      'Например, 15% от конечной громкости.', '15',
      { '5': '5%', '10': '10%', '15': '15%', '20': '20%', '25': '25%', '30': '30%' });
    addParam('max_volume', 'select', 'Предел громкости телевизора',
      'Процент от шкалы громкости Android TV.', '20',
      { '5': '5%', '10': '10%', '15': '15%', '20': '20%', '25': '25%',
        '30': '30%', '40': '40%', '50': '50%', '75': '75%', '100': '100%' });
    addParam('ramp_minutes', 'select', 'Время нарастания',
      'Плавно увеличивать громкость за указанное время.', '10',
      { '0': 'Сразу', '2': '2 минуты', '5': '5 минут', '10': '10 минут',
        '15': '15 минут', '20': '20 минут', '30': '30 минут' });

    addTitle('Онлайн-плагины — диагностика');
    addParam('online_components','button','Найти онлайн-компоненты',
      'Показывает зарегистрированные Lampa онлайн-источники и те, '+
      'которые уже открывались. Каталог и HTTP 200 не доказывают работу.',
      '',null,showOnlineInventory);
    addTitle('Повтор онлайн-серии — тест');
    addParam('online_route_info','button','Сохранённый онлайн-маршрут',
      'Показывает плагин, балансер и последнюю серию без URL видео.',
      '',null,function(){
        var item=onlineReplayCandidate();
        notice(item ? item.provider+' / '+(item.balancer||'неизвестный источник')+
          ', S'+(item.season||'?')+'E'+(item.episode||'?') :
          'Для выбранного сериала нет истории онлайн-просмотра');
      });
    addParam('online_open_source','button','Открыть сохранённый онлайн-источник',
      'Открыть тот же плагин/балансер, но выбрать серию вручную.',
      '',null,function(){startOnlineReplay(false)});
    addParam('online_auto_episode','button','Тест выбора онлайн-серии',
      'Заново открыть плагин и попробовать выбрать точно сохранённый эпизод.',
      '',null,function(){startOnlineReplay(true)});
    addParam('online_launch_info','button','Состояние онлайн-теста',
      'Показывает текущий этап и результат. URL видео не сохраняется.',
      '',null,function(){notice(onlineStatusText())});
    addParam('online_launch_cancel','button','Отменить онлайн-тест',
      'Прекратить автоматический поиск серии, оставив экран открытым.',
      '',null,cancelOnlineRoute);
    addParam('online_rows_diag','button','Диагностика списка серий',
      'Показывает сколько строк и номеров серии удалось прочитать у плагина.',
      '',null,function(){notice(onlineRowDiagnosticsText())});

    addTitle('Подготовка TorrServer');
    addParam('torrent_wait_seconds','select','Максимальное ожидание видео',
      'Включает ожидание ответа TorrServer, предзагрузку и запуск плеера.',
      '180',{ '60':'1 минута','120':'2 минуты','180':'3 минуты',
      '240':'4 минуты','300':'5 минут' });
    addParam('torrent_prebuffer','trigger','Ждать предварительную загрузку',
      'Если в Lampa включён режим preload, дождаться подготовки буфера.',
      true);
    addParam('torrent_launch_info','button','Состояние последнего запуска',
      'Показывает этап, время ожидания и прогресс буфера.', '',null,
      function(){notice(launchReportText());});
    addParam('torrent_launch_cancel','button','Остановить подготовку',
      'Отмена ожидания TorrServer без выключения телевизора.', '',null,
      abortTorrentLaunch);

    addTitle('Проверка воспроизведения');
    addParam('torrent_file_check', 'button', 'Проверить сохранение файла TorrServer',
      'Покажет, сохранились ли хэш и индекс файла после выбора серии.', '', null,
      function () { notice(bookmarkDiagnosticMessage()); });
    addParam('manual_torrent', 'button', 'Запустить сохранённую серию TorrServer',
      'Ручной тест по актуальной ссылке с TorrServer (требует ранее запущенного файла).',
      '', null, launchTorrentSeries);
    addParam('manual_online', 'button', 'Повторить недавнюю онлайн-серию',
      'Только в этой сессии Lampa и в течение двух минут после запуска видео.',
      '', null, launchOnlineSession);
    addParam('startup_test_enabled', 'trigger', 'Тест при следующем включении TV',
      'Однократно запустить сохранённую серию TorrServer при следующем запуске ' +
      'или возврате Lampa из сна. Расписание не используется.', false, null, armOneShotTest);
    addParam('startup_test_status', 'button', 'Состояние тестового запуска',
      'Проверить, подготовлен ли следующий запуск.', '', null, testStatus);

    addTitle('Проверка');
    addParam('test', 'button', 'Проверить уведомление',
      'Покажет тестовое уведомление. Видео не запустится, громкость не изменится.', '', null,
      function () {
        notice('Lampa Alarm 0.7.2: тест пройден, настройки доступны.');
        log('Manual test performed');
      });
    addParam('status', 'button', 'Показать текущие настройки',
      'Сводка сохранённого расписания.', '', null,
      function () {
        var data = settingsSnapshot();
        notice('Будильник: ' + (data.enabled ? 'включён' : 'выключен') +
          ', ' + data.time + ', дней: ' + data.days.length + '/7');
      });

    log('SettingsApi registered');
  }
  function init() {
    if (started) return;
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.Settings) return;
    started = true;
    try {
      setupSettings();
    } catch (e) {
      log('Setup failed: ' + e.message);
      notice('Lampa Alarm 0.7.2: ошибка регистрации настроек');
    }
    // Let the native Settings.main().update() build the menu entry and bind
    // the built-in hover:enter handler. Never append a data-static fallback.
    try {
      var main = Lampa.Settings.main();
      if (main && typeof main.update === 'function') main.update();
    } catch (e) { log('Native menu update error: ' + e.message); }
    // The "full" event is emitted when a film/series card finishes rendering.
    // Only TV-series cards receive the alarm button.
    try {
      if (Lampa.Listener && typeof Lampa.Listener.follow === 'function')
        Lampa.Listener.follow('full', watchFullCard);
      if (Lampa.Listener && typeof Lampa.Listener.follow==='function')
        Lampa.Listener.follow('activity', function(e){
          onOnlineActivityEvent(e);
          observeOnlineActivity(e);
          if (!e || (e.type!=='start' && e.type!=='create')) return;
          var selected=selectedSeries();
          if (!selected) return;
          var ctx=activitySnapshot(e.object,selected,true);
          if(ctx)lastOnlineContext=ctx;
          else if(e.object && e.object.component &&
              !/^(?:player|player-loading)$/i.test(e.object.component)) {
            lastOnlineContext=null;
            playerCreateContext=null;
          }
        });
      if (Lampa.Listener && typeof Lampa.Listener.follow === 'function')
        Lampa.Listener.follow('torrent_file', onTorrentFileEvent);
    } catch (e) { log('Card listener failed: ' + e.message); }
    try {
      if (Lampa.Player && Lampa.Player.listener &&
          typeof Lampa.Player.listener.follow === 'function') {
        Lampa.Player.listener.follow('create', onPlayerCreate);
        Lampa.Player.listener.follow('start', onPlayerStart);
        Lampa.Player.listener.follow('external', onPlayerExternal);
        Lampa.Player.listener.follow('destroy', onPlayerDestroy);
      } else {
        log('Player listener not available');
      }
    } catch (e) { log('Player subscription error: ' + e.message); }
    setInterval(checkHeartbeat, 15000);
    // A cold WebView startup is different from an already running app.
    // A suspended WebView is handled by visibility/focus or a long timer gap.
    startupTimer = setTimeout(function () {
      tryArmedStartupTest('новый запуск', 0);
    }, 4500);
    window.addEventListener('focus', visibilityChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    document.addEventListener('keydown', markInteraction, false);
    document.addEventListener('mousedown', markInteraction, false);
    document.addEventListener('touchstart', markInteraction, false);
    checkSchedule();
    window.LampaAlarm = {
      version: VERSION,
      getConfig: settingsSnapshot,
      getSelectedSeries: selectedSeries,
      getLastPlayback: lastPlayback,
      getPlaybackHistory: playbackHistory,
      getCaptureDiagnostic: captureDiagnostic,
      testEpisodeParser: extractEpisodeFromTitle,
      getTestStatus: function () {
        return { armed: enabled('startup_test_enabled', false),
          hasTorrentBookmark: canLaunchTorrent() };
      },
      testTorrentPlayback: launchTorrentSeries,
      getTorrentLaunchStatus: launchReport,
      getOnlineReplayCandidate: onlineReplayCandidate,
      listOnlineComponents: onlineComponentInventory,
      getOnlineLaunchStatus: onlineStatus,
      getOnlineRowsDiagnostics: onlineRowDiagnostics,
      testOnlineRoute: function(){return startOnlineReplay(true)},
      openOnlineSource: function(){return startOnlineReplay(false)},
      cancelOnlineRoute: cancelOnlineRoute,
      cancelTorrentLaunch: abortTorrentLaunch,
      testOnlinePlayback: launchOnlineSession,
      armStartupTest: armOneShotTest,
      selectSeries: chooseSeries,
      clearSeries: clearSelectedSeries,
      getWakeState: function () {
        return wakeObservation ? {
          at: wakeObservation.at,
          reason: wakeObservation.reason,
          inactivityMs: wakeObservation.inactivityMs
        } : null;
      },
      check: checkSchedule,
      test: function () { notice('Lampa Alarm 0.7.2: тест пройден.'); }
    };
    log('Initialized');
  }

  try {
    if (window.Lampa && Lampa.Listener && Lampa.Listener.follow) {
      Lampa.Listener.follow('app', function (event) {
        if (event && event.type === 'ready') init();
      });
    }
    if (window.appready) init();
    else {
      var attempts = 0;
      var wait = setInterval(function () {
        if (window.appready) {
          clearInterval(wait);
          init();
        } else if (++attempts >= 120) {
          clearInterval(wait);
          log('Timeout waiting for appready');
        }
      }, 500);
    }
  } catch (e) { log('Bootstrap error: ' + e.message); }
})();