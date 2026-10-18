(function () {
  'use strict';
  var NAME = 'lampa_alarm';
  var VERSION = '0.1.3';
  function log(s) { try { console.log('[Lampa Alarm ' + VERSION + '] ' + s); } catch (e) {} }
  function addMenu() {
    try {
      if (!window.Lampa || !Lampa.Settings || !Lampa.Settings.main) return;
      var main = Lampa.Settings.main();
      if (!main || !main.render) return;
      var body = main.render();
      if (!body || !body.find) return;
      if (body.find('[data-component="' + NAME + '"]').length) return;
      var field = '<div class="settings-folder selector" data-component="' + NAME + '">' +
        '<div class="settings-folder__icon"><svg viewBox="0 0 24 24" width="24" height="24">' +
        '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M12 7v5l4 2" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>' +
        '<div class="settings-folder__name">Будильник (тест 0.1.3)</div></div>';
      var anchor = body.find('[data-component="more"]');
      if (anchor.length) anchor.after(field);
      else body.append(field);
      if (main.update) main.update();
      log('Menu entry added');
    } catch (e) { log('Menu error: ' + e.message); }
  }
  function bindMenu(e) {
    try {
      if (!e || e.name !== 'main' || !e.body) return;
      e.body.find('[data-component="' + NAME + '"]').off('hover:enter.lampaAlarm').on('hover:enter.lampaAlarm', function () {
        if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('Lampa Alarm 0.1.3: пункт меню работает');
        log('Menu item activated');
      });
    } catch (err) { log('Bind error: ' + err.message); }
  }
  function start() {
    if (!window.Lampa || !Lampa.Settings || !Lampa.Settings.listener) {
      log('Settings API not ready');
      return;
    }
    if (!window.__lampaAlarm013Started) {
      window.__lampaAlarm013Started = true;
      Lampa.Settings.listener.follow('open', bindMenu);
    }
    addMenu();
  }
  try {
    if (window.Lampa && Lampa.Listener && Lampa.Listener.follow) {
      Lampa.Listener.follow('app', function (e) { if (e && e.type === 'ready') start(); });
    }
    if (window.appready) start();
    else {
      var attempts = 0;
      var timer = setInterval(function () {
        if (window.appready) { clearInterval(timer); start(); }
        else if (++attempts >= 60) { clearInterval(timer); log('App ready timeout'); }
      }, 500);
    }
  } catch (e) { log('Init error: ' + e.message); }
})();