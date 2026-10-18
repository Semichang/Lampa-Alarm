(function(){
'use strict';
if(window.__lampaAlarmLoaded)return;
window.__lampaAlarmLoaded=true;
const KEY='lampa_alarm_v010';
const defaults={enabled:false,time:'07:00',days:[0,1,2,3,4,5,6],lastRun:'',source:'last',episode:'resume',volumeMode:'restore',startPercent:15,maxVolumePercent:20,rampMinutes:10};
let cfg={...defaults};
try{cfg={...cfg,...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch(e){}
function save(){localStorage.setItem(KEY,JSON.stringify(cfg))}
function note(s){if(window.Lampa?.Noty?.show)Lampa.Noty.show(s);else console.log('[Lampa Alarm]',s)}
function dateKey(d){return [d.getFullYear(),d.getMonth()+1,d.getDate()].join('-')}
function check(){const d=new Date(),m=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(cfg.time);if(!cfg.enabled||!m||!cfg.days.includes(d.getDay())||cfg.lastRun===dateKey(d))return;const t=Number(m[1])*60+Number(m[2]),n=d.getHours()*60+d.getMinutes();if(n>=t&&n<t+3){cfg.lastRun=dateKey(d);save();note('Lampa Alarm: время будильника. Автозапуск видео ещё не реализован.')}}
function addSettings(){if(!window.Lampa?.SettingsApi?.addParam)return;
const api=Lampa.SettingsApi;
try{
api.addComponent({component:'lampa_alarm',name:'Будильник',icon:'<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l4 2" stroke="currentColor" fill="none" stroke-width="2"/></svg>'});
function param(name,type,values,label,description,convert){api.addParam({component:'lampa_alarm',param:{name,type,values,default:String(cfg[name])},field:{name:label,description},onChange:v=>{const value=convert?convert(v):v;if(value===undefined)return;cfg[name]=value;save()}})}
param('enabled','select',{'true':'Включён','false':'Выключен'},'Будильник','Проверка времени при активной Lampa',v=>v===true||v==='true');
param('time','input',undefined,'Время','Формат ЧЧ:ММ',v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v)?v:undefined);
param('source','select',{last:'Последний',online:'Онлайн',torrent:'TorrServer'},'Источник','Автозапуск пока не подключён');
param('episode','select',{resume:'Продолжить',next:'Следующая',repeat:'Повторить'},'Серия','Автозапуск пока не подключён');
param('maxVolumePercent','input',undefined,'Предел громкости, %','Системная регулировка пока не подключена',v=>{const n=Number(v);return n>=0&&n<=100?n:undefined});
param('rampMinutes','input',undefined,'Нарастание, мин','Системная регулировка пока не подключена',v=>{const n=Number(v);return n>=0&&n<=60?n:undefined});
}catch(e){console.error('[Lampa Alarm] Settings error',e)}
}
window.LampaAlarm={getConfig:()=>({...cfg}),set:p=>{if(!p||typeof p!=='object')return;const n={...cfg,...p};if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(n.time))throw Error('Invalid time');if(!Array.isArray(n.days)||n.days.some(x=>!Number.isInteger(x)||x<0||x>6))throw Error('Invalid days');cfg=n;save()},test:()=>note('Lampa Alarm: тест. Воспроизведение пока не реализовано.'),check};
function boot(){addSettings();check();setInterval(check,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)check()});window.addEventListener('focus',check);note('Lampa Alarm 0.1.1: плагин запущен');console.log('[Lampa Alarm] v0.1.1 loaded')}
let started=false;function ready(){if(started||!window.Lampa?.SettingsApi||!window.appready)return;started=true;boot()}
if(window.Lampa?.Listener?.follow){Lampa.Listener.follow('app',e=>{if(e.type==='ready')ready()})}
let tries=0;const timer=setInterval(()=>{ready();if(started||++tries>120){clearInterval(timer);if(!started)console.warn('[Lampa Alarm] init timeout')}},500);ready();
})();