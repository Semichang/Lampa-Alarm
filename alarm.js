(function () {
  'use strict';

  // Lampa Alarm v0.6.0: one-shot startup test and manual TorrServer replay.
  // Scheduled playback and Android system-volume control are still disabled.
  var VERSION = '0.6.0';
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

  if (window.__lampaAlarm060Loaded) return;
  window.__lampaAlarm060Loaded = true;

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
    var s = plainLabel(value, 240);
    if (!s) return { season: null, episode: null, method: '' };
    var matches, a=null, b=null;
    // Common "S02E03", "S2.E3", "Season 2 Episode 3" and "2x03".
    matches = /(?:^|[^a-z0-9])s(?:eason)?\s*0*(\d{1,2})[\s._:/-]*e(?:p(?:isode)?)?\s*0*(\d{1,3})(?!\d)/i.exec(s);
    if (matches) { a=numberOrNull(matches[1]);b=numberOrNull(matches[2]); }
    if (!a || !b) {
      matches = /(?:^|[^a-z0-9])0*(\d{1,2})\s*x\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if (matches) { a=numberOrNull(matches[1]);b=numberOrNull(matches[2]); }
    }
    // "S1 / Серия 5", "Сезон 2 / Серия 9", "Season 1 / Episode 3".
    if (!a || !b) {
      matches = /(?:сезон(?:а|е)?|season|s)\s*№?\s*0*(\d{1,2})[\s\S]{0,32}?(?:сер(?:ия|ии|ию)|эпизод|episode|ep\.?)\s*№?\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if (matches) { a=numberOrNull(matches[1]);b=numberOrNull(matches[2]); }
    }
    // "2 сезон 5 серия" (season index appears before Russian label).
    if (!a || !b) {
      matches = /(?:^|[^\d])0*(\d{1,2})\s*(?:-?(?:й|ый|го))?\s*сезон[\s\S]{0,32}?(?:сер(?:ия|ии|ию)|эпизод)\s*№?\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if(matches){a=numberOrNull(matches[1]);b=numberOrNull(matches[2]);}
    }
    if (!a || !b) {
      // We may safely identify an episode without assuming a season.
      matches = /(?:сер(?:ия|ии|ию)|эпизод|episode|ep\.?)\s*№?\s*0*(\d{1,3})(?!\d)/i.exec(s);
      if (matches) b=numberOrNull(matches[1]);
      matches = /(?:сезон(?:а|е)?|season)\s*№?\s*0*(\d{1,2})(?!\d)/i.exec(s);
      if (matches) a=numberOrNull(matches[1]);
    }
    return { season: a, episode: b, method: a && b ? 'название' : b ? 'частично из названия' : '' };
  }

  function episodeMetadata(data) {
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
      data && data.item && data.item.title
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

  function activitySnapshot(activity, selected, allowRecentFull) {
    if (!activity || !selected) return null;
    var component=plainLabel(activity.component || '',100);
    if (!component || /^(full|main|settings|player|youtube|trailer)$/i.test(component))
      return null;
    var card=getCardFromActivity(activity);
    if (card && (card.id || card.tmdb_id)) {
      if (!isSameCard(card,selected)) return null;
      return { at:Date.now(),component:component,
        title:plainLabel(activity.title || '',100), method:'активный экран',
        selectedId:selected.id, selectedSource:selected.source };
    }
    if (allowRecentFull && sourceComponentIsOnline(component) &&
        lastFullCard && lastFullCard.selectedId===selected.id &&
        lastFullCard.selectedSource===selected.source &&
        Date.now()-lastFullCard.at<=120000) {
      return {at:Date.now(),component:component,
        title:plainLabel(activity.title || '',100),
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
    var active=detectActivityContext(selected);
    if (active) {
      lastOnlineContext=active;
      return active;
    }
    if (playerCreateContext && Date.now()-playerCreateContext.at<=120000 &&
        playerCreateContext.selectedId===selected.id &&
        playerCreateContext.selectedSource===selected.source) return playerCreateContext;
    if (lastOnlineContext && Date.now()-lastOnlineContext.at<=30000 &&
        lastOnlineContext.selectedId===selected.id &&
        lastOnlineContext.selectedSource===selected.source) return lastOnlineContext;
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
      var metadata=episodeMetadata(data);
      var isTorrent=Boolean(data.torrent_hash ||
        parseTorrentStreamUrl(data.url).hash);
      var provider=providerForPlayback(data,context,selected,isTorrent);
      var old=lastPlayback();
      // Preserve richer data across the internal-start / Android-external
      // pair for the same episode (the second event may omit metadata).
      var sameRecent=old && old.seriesId===selected.id &&
        old.source===selected.source &&
        old.sourceType===(isTorrent?'torrent':'online') &&
        Date.now()-Date.parse(old.capturedAt||0)<120000;
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
    clearVideoHandlers();
    capturePlayback(data, 'external');
  }

  function onPlayerDestroy() {
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

  function launchTorrentSeries() {
    var selected = selectedSeries();
    var bookmark = torrentBookmark();
    if (!isBookmarkCurrent(bookmark, selected)) {
      notice(bookmarkDiagnosticMessage());
      return false;
    }
    if (!Lampa.Torserver || typeof Lampa.Torserver.files !== 'function' ||
        typeof Lampa.Torserver.stream !== 'function' ||
        !Lampa.Player || typeof Lampa.Player.play !== 'function') {
      notice('На этом устройстве недоступен нужный API TorrServer');
      return false;
    }
    if (launchInProgress ||
        (Lampa.Player.opened && Lampa.Player.opened())) {
      notice('Плеер уже запущен');
      return false;
    }

    launchInProgress = true;
    notice('Будильник: загружаю сохранённую серию TorrServer...');
    var finished = false;
    var timeoutId;
    function finish(message) {
      if (finished) return;
      finished = true;
      launchInProgress = false;
      if (typeof clearTimeout === 'function') clearTimeout(timeoutId);
      if (message) {
        notice(message);
        log(message);
      }
    }
    try {
      timeoutId = setTimeout(function () {
        finish('TorrServer не ответил за 15 секунд');
      }, 15000);
      Lampa.Torserver.files(bookmark.hash, function (response) {
        if (finished) return;
        try {
          var files = response && response.file_stats;
          if (!Array.isArray(files)) return finish('TorrServer не вернул файлы');
          var file = null;
          for (var i = 0; i < files.length; i++) {
            if (Number(files[i].id) === bookmark.fileIndex) {
              file = files[i]; break;
            }
          }
          if (!file || typeof file.path !== 'string' || !file.path)
            return finish('Сохранённая серия не найдена на TorrServer');
          var url = Lampa.Torserver.stream(file.path, bookmark.hash, bookmark.fileIndex);
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
            return finish('TorrServer не вернул действительную ссылку');

          var card = {
            id: /^\d+$/.test(selected.id) ? Number(selected.id) : selected.id,
            source: selected.source,
            name: selected.title,
            title: selected.title,
            original_name: selected.originalTitle || selected.title,
            original_title: selected.originalTitle || selected.title
          };
          var data = {
            url: url,
            title: bookmark.episodeTitle ||
              file.path.split(/[\\/]/).pop(),
            card: card,
            movie: card,
            torrent_hash: bookmark.hash,
            id: bookmark.fileIndex,
            season: bookmark.season,
            episode: bookmark.episode
          };
          if (bookmark.season && bookmark.episode &&
              Lampa.Timeline && Lampa.Timeline.link &&
              Lampa.Timeline.view && Lampa.Utils && Lampa.Utils.hash) {
            try {
              var meta = Lampa.Timeline.link(card, bookmark.season, bookmark.episode);
              var h = Lampa.Utils.hash([
                bookmark.season,
                bookmark.season > 10 ? ':' : '',
                bookmark.episode,
                card.original_name
              ].join(''));
              data.timeline = Lampa.Timeline.view(h, meta);
            } catch (e) { log('Timeline metadata error: ' + e.message); }
          }
          launchInProgress = false;
          manualRunPlayer(data);
          finish();
        } catch (e) {
          finish('Ошибка запуска серии TorrServer');
          log('Playback error: ' + e.message);
        }
      }, function () { finish('Ошибка запроса файлов TorrServer'); });
      return true;
    } catch (e) {
      finish('Не удалось обратиться к TorrServer');
      log('TorrServer call failed: ' + e.message);
      return false;
    }
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
      torrentBookmarkStatus: bookmarkDiagnosticMessage()
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
        notice('Lampa Alarm 0.6.0: тест пройден, настройки доступны.');
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
      notice('Lampa Alarm 0.6.0: ошибка регистрации настроек');
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
          if (!e || (e.type!=='start' && e.type!=='create')) return;
          var selected=selectedSeries();
          if (!selected) return;
          var ctx=activitySnapshot(e.object,selected,true);
          if(ctx)lastOnlineContext=ctx;
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
      test: function () { notice('Lampa Alarm 0.6.0: тест пройден.'); }
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