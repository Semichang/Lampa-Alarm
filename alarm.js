(function () {
  'use strict';

  // Lampa Alarm v0.2.0: settings and schedule notification only.
  // This version intentionally does not start videos or change Android volume.
  var VERSION = '0.2.0';
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

  if (window.__lampaAlarm020Loaded) return;
  window.__lampaAlarm020Loaded = true;

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
      lastRun: String(read('last_run', ''))
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
      if (minute < scheduled || minute > scheduled + 10) return;
      var key = keyForDate(now);
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
    if (values) param.values = values;
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
        notice('Lampa Alarm 0.2.0: тест пройден, настройки доступны.');
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
  function fallbackMenu() {
    try {
      var main = Lampa.Settings.main();
      if (!main || !main.render) return;
      var body = main.render();
      if (!body || !body.find || body.find('[data-component="' + COMPONENT + '"]').length) return;
      var html = '<div class="settings-folder selector lampa-alarm-fallback" data-component="' +
        COMPONENT + '" data-static="true">' +
        '<div class="settings-folder__icon">' + ICON + '</div>' +
        '<div class="settings-folder__name">Будильник</div></div>';
      var anchor = body.find('[data-component="more"]');
      if (anchor.length) anchor.after(html);
      else body.append(html);
      if (main.update) main.update();
      log('Fallback menu entry added');
    } catch (e) { log('Fallback error: ' + e.message); }
  }
  function bindFallback(event) {
    try {
      if (!event || event.name !== 'main' || !event.body) return;
      event.body.find('.lampa-alarm-fallback')
        .off('hover:enter.lampaAlarm')
        .on('hover:enter.lampaAlarm', function () {
          try {
            Lampa.Settings.create(COMPONENT, {
              onBack: function () { Lampa.Settings.create('main'); }
            });
          } catch (e) {
            log('Open alarm settings failed: ' + e.message);
            notice('Не удалось открыть настройки будильника.');
          }
        });
    } catch (e) { log('Bind fallback error: ' + e.message); }
  }
  function init() {
    if (started) return;
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.Settings) return;
    started = true;
    try {
      setupSettings();
    } catch (e) {
      log('Setup failed: ' + e.message);
      notice('Lampa Alarm 0.2.0: ошибка регистрации настроек');
    }
    try { Lampa.Settings.listener.follow('open', bindFallback); } catch (e) {
      log('Settings listener error: ' + e.message);
    }
    setTimeout(fallbackMenu, 300);
    setInterval(checkSchedule, 15000);
    window.addEventListener('focus', checkSchedule);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkSchedule();
    });
    checkSchedule();
    window.LampaAlarm = {
      version: VERSION,
      getConfig: settingsSnapshot,
      check: checkSchedule,
      test: function () { notice('Lampa Alarm 0.2.0: тест пройден.'); }
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