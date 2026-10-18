(function () {
  'use strict';
  var VERSION = '0.1.2';
  function log(message) { try { console.log('[Lampa Alarm ' + VERSION + '] ' + message); } catch (e) {} }
  function notify(message) {
    try {
      if (window.Lampa && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
        Lampa.Noty.show(message);
      } else { log(message); }
    } catch (e) { log('Notification error: ' + e.message); }
  }
  function init() {
    if (window.__lampaAlarm012Initialized) return;
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;
    window.__lampaAlarm012Initialized = true;
    try {
      Lampa.SettingsApi.addComponent({
        component: 'lampa_alarm',
        name: 'Будильник',
        icon: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l4 2" stroke="currentColor" fill="none" stroke-width="2"/></svg>'
      });
      log('Settings component registered');
      notify('Lampa Alarm 0.1.2: компонент зарегистрирован');
    } catch (e) {
      log('Settings component failed: ' + e.message);
      notify('Lampa Alarm: ошибка настроек');
    }
  }
  log('Script executed');
  notify('Lampa Alarm 0.1.2: скрипт загружен');
  try {
    if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
      Lampa.Listener.follow('app', function (event) {
        if (event && event.type === 'ready') init();
      });
    }
  } catch (e) { log('Listener failed: ' + e.message); }
  init();
  var tries = 0;
  var timer = setInterval(function () {
    init();
    tries += 1;
    if (window.__lampaAlarm012Initialized || tries >= 60) {
      clearInterval(timer);
      if (!window.__lampaAlarm012Initialized) log('Settings API not ready after 30 seconds');
    }
  }, 500);
})();