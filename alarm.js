(function () {
  'use strict';

  // Lampa Alarm v0.4.0: settings and schedule notification only.
  // This version intentionally does not start videos or change Android volume.
  var VERSION = '0.4.0';
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

  if (window.__lampaAlarm040Loaded) return;
  window.__lampaAlarm040Loaded = true;

  // Best-effort wake detection: this cannot identify the TV power-on reason.
  // Unknown/unobserved wake never triggers a wake-guarded alarm.
  var wakeObservation = null;
  var hiddenAt = null;
  var lastHeartbeatAt = Date.now();
  var lastInteractionAt = 0;

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
    checkSchedule();
  }

  function visibilityChanged() {
    var now = Date.now();
    if (document.hidden) {
      hiddenAt = now;
      return;
    }
    if (hiddenAt !== null) {
      rememberWake('возврат приложения', now - hiddenAt, now);
      hiddenAt = null;
    } else {
      var gap = now - lastHeartbeatAt;
      if (gap >= wakeThresholdMs()) rememberWake('пауза таймера', gap, now);
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

  function clearSelectedSeries() {
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

  function matchPlayback(data, selected) {
    if (!data || !selected) return null;

    if (data.card && isSameCard(data.card, selected)) return 'card';
    if (data.movie && isSameCard(data.movie, selected)) return 'movie';
    // If the player explicitly identifies a different card, never
    // fall back to the current screen or match by title.
    if ((data.card && data.card.id) || (data.movie && data.movie.id)) return null;

    var timeline = data.timeline;
    if (timeline && typeof timeline === 'object' &&
        timeline.card && String(timeline.card) === timelineKeyForSeries(selected))
      return 'timeline';

    if (timeline && timeline.card) return null;

    // Only use Activity metadata on a recognized media-list screen.
    // Even then, this is just a diagnostic observation, not proof that the
    // stream belongs to the series, so do not use it for a persisted match.
    return null;
  }

  function episodeNumber(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 && n < 10000 && Math.floor(n) === n ? n : null;
  }

  function capturePlayback(data, mode) {
    try {
      if (!enabled('capture_playback', true)) return null;
      var selected = selectedSeries();
      var match = matchPlayback(data, selected);
      if (!match) {
        currentPlayback = null;
        return null;
      }

      var tl = data.timeline && typeof data.timeline === 'object' ?
        data.timeline : {};
      var series = {
        seriesId: selected.id,
        title: selected.title,
        source: selected.source,
        sourceType: data.torrent_hash ? 'torrent' : 'online',
        playerMode: mode,
        matchMethod: match,
        season: episodeNumber(tl.season || data.season),
        episode: episodeNumber(tl.episode || data.episode),
        episodeTitle: String(data.title || '').slice(0, 200),
        positionSeconds: Number(tl.time) > 0 ? Math.round(Number(tl.time)) : 0,
        durationSeconds: Number(tl.duration) > 0 ? Math.round(Number(tl.duration)) : 0,
        ended: false,
        capturedAt: new Date().toISOString()
      };

      currentPlayback = series;
      save('last_playback', series);
      log('Captured ' + series.sourceType + ' playback, match=' + match +
          ', season=' + series.season + ', episode=' + series.episode);
      return series;
    } catch (e) {
      log('Capture playback error: ' + e.message);
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
      }
    };
    var ended = function () {
      if (!currentPlayback || currentPlayback !== observation) return;
      currentPlayback.ended = true;
      currentPlayback.positionSeconds = currentPlayback.durationSeconds;
      save('last_playback', currentPlayback);
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
    if (currentPlayback && currentPlayback.playerMode === 'internal')
      save('last_playback', currentPlayback);
    currentPlayback = null;
    clearVideoHandlers();
  }

  function formatPlayback(item) {
    if (!item) return 'Данных нет. Выбери сериал и запусти его обычным способом.';
    var episode = item.season && item.episode ?
      ' — сезон ' + item.season + ', серия ' + item.episode : ' — номер серии не определён';
    var source = item.sourceType === 'torrent' ? 'TorrServer' : 'Онлайн';
    var player = item.playerMode === 'external' ? 'внешний плеер' : 'плеер Lampa';
    return item.title + episode + '. ' + source + ', ' + player + '.';
  }

  function clearLastPlayback() {
    save('last_playback', '');
    currentPlayback = null;
    notice('Будильник: история тестового воспроизведения очищена');
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
      lastPlayback: lastPlayback()
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

    addTitle('Проверка');
    addParam('test', 'button', 'Проверить уведомление',
      'Покажет тестовое уведомление. Видео не запустится, громкость не изменится.', '', null,
      function () {
        notice('Lampa Alarm 0.4.0: тест пройден, настройки доступны.');
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
      notice('Lampa Alarm 0.4.0: ошибка регистрации настроек');
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
        Lampa.Listener.follow('full', addSeriesButton);
    } catch (e) { log('Card listener failed: ' + e.message); }
    try {
      if (Lampa.Player && Lampa.Player.listener &&
          typeof Lampa.Player.listener.follow === 'function') {
        Lampa.Player.listener.follow('start', onPlayerStart);
        Lampa.Player.listener.follow('external', onPlayerExternal);
        Lampa.Player.listener.follow('destroy', onPlayerDestroy);
      } else {
        log('Player listener not available');
      }
    } catch (e) { log('Player subscription error: ' + e.message); }
    setInterval(checkHeartbeat, 15000);
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
      test: function () { notice('Lampa Alarm 0.4.0: тест пройден.'); }
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