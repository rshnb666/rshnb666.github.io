// ============ B站风视频收藏 App ============
var API = 'https://vapp.rsh200891.workers.dev'; // Worker 地址（部署后如不同请改这里）
var ALL = [];
var TOKEN = '';
var USER = '';
var curTag = '';
var view = 'home';

function $(id) { return document.getElementById(id); }
function toast(t) {
  var el = $('toast');
  el.textContent = t;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(function () { el.style.display = 'none'; }, 2000);
}

// ---------- 登录/注册 ----------
var mode = 'login';
function switchAuth(m) {
  mode = m;
  document.querySelectorAll('.login-tabs div').forEach(function (d, i) {
    d.className = (m === 'login' ? i === 0 : i === 1) ? 'on' : '';
  });
  $('auth-btn').textContent = m === 'login' ? '登 录' : '注册并登录';
  $('login-msg').textContent = '';
}
function doAuth() {
  var u = $('auth-user').value.trim();
  var p = $('auth-pass').value;
  var msg = $('login-msg');
  if (!u || !p) { msg.textContent = '请输入用户名和密码'; return; }
  if (u.length < 2 || p.length < 6) { msg.textContent = '用户名≥2字符，密码≥6位'; return; }
  var btn = $('auth-btn');
  btn.disabled = true;
  callAPI(mode === 'login' ? '/api/login' : '/api/register', { u: u, p: p }).then(function (res) {
    btn.disabled = false;
    if (res.body && res.body.ok) {
      TOKEN = res.body.token || '';
      USER = res.body.user || u;
      enterApp();
    } else {
      msg.textContent = '❌ ' + ((res.body && res.body.error) || '请求失败');
    }
  }).catch(function () {
    btn.disabled = false;
    msg.textContent = '❌ 无法连接服务器（请检查 Worker 是否已部署）';
  });
}
function enterApp() {
  $('login-view').style.display = 'none';
  $('app-view').style.display = '';
  $('top-user').textContent = USER;
  loadData();
}
function logout() {
  TOKEN = ''; USER = '';
  $('app-view').style.display = 'none';
  $('login-view').style.display = '';
  $('auth-pass').value = '';
}

// ---------- API ----------
function callAPI(path, payload) {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  }).then(function (r) {
    return r.json().then(function (j) { return { http: r.status, body: j }; });
  });
}

// ---------- 数据 ----------
function loadData() {
  fetch('/videos/index.json', { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error('no data');
    return r.json();
  }).then(function (list) {
    ALL = list || [];
    renderHome();
    buildChips();
    $('me-count').textContent = ALL.length;
  }).catch(function () {
    $('feed').innerHTML = '<p class="empty-tip">数据加载失败，请稍后刷新</p>';
  });
}

function embedSrc(link) {
  if (!link) return '';
  var bv = link.match(/BV[0-9A-Za-z]{8,}/);
  if (bv) return 'https://player.bilibili.com/player.html?bvid=' + bv[0] + '&autoplay=0';
  var yt = link.match(/(?:youtu\.be\/|watch\?v=|shorts\/|embed\/)([0-9A-Za-z_-]{6,})/);
  if (yt) return 'https://www.youtube-nocookie.com/embed/' + yt[1];
  return link;
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function cardHtml(v) {
  var cover = v.cover ? '<img loading="lazy" src="' + esc(v.cover) + '" alt="" />'
    : '<div class="fallback">▶</div>';
  var tag = v.tag ? '<span class="tag-chip">' + esc(v.tag) + '</span>' : '';
  return '<div class="card" data-id="' + esc(v.id) + '">' +
    '<div class="cover">' + cover + tag + '</div>' +
    '<div class="card-body">' +
      '<div class="card-title">' + esc(v.title) + '</div>' +
      '<div class="card-meta"><span>' + esc(v.tag || '未分类') + '</span><span>' + esc(v.date || '') + '</span></div>' +
    '</div></div>';
}

function filterBy(kw, tag) {
  var k = kw.toLowerCase();
  return ALL.filter(function (v) {
    var okTag = !tag || v.tag === tag;
    var text = ((v.title || '') + ' ' + (v.desc || '')).toLowerCase();
    return okTag && (!k || text.indexOf(k) >= 0);
  });
}

function renderHome() {
  var kw = $('search-input').value.trim();
  var list = filterBy(kw, '');
  var feed = $('feed');
  $('empty-tip').style.display = list.length ? 'none' : 'block';
  feed.innerHTML = list.map(cardHtml).join('');
  bindCards(feed);
}
function renderCat() {
  var kw = $('search-input').value.trim();
  var list = filterBy(kw, curTag);
  $('feed-cat').innerHTML = list.length ? list.map(cardHtml).join('') : '<p class="empty-tip">这个分区还没有视频</p>';
  bindCards($('feed-cat'));
}
function bindCards(box) {
  Array.prototype.forEach.call(box.querySelectorAll('.card'), function (c) {
    c.addEventListener('click', function () { openPlayer(c.getAttribute('data-id')); });
  });
}
function buildChips() {
  var tags = [];
  ALL.forEach(function (v) { if (v.tag && tags.indexOf(v.tag) < 0) tags.push(v.tag); });
  var html = '<div class="chip' + (curTag === '' ? ' on' : '') + '" data-t="">全部</div>';
  tags.forEach(function (t) {
    html += '<div class="chip' + (curTag === t ? ' on' : '') + '" data-t="' + esc(t) + '">' + esc(t) + '</div>';
  });
  $('chip-row').innerHTML = html;
}
$('chip-row').addEventListener('click', function (e) {
  var c = e.target.closest('.chip');
  if (!c) return;
  curTag = c.getAttribute('data-t') || '';
  buildChips();
  renderCat();
});

// ---------- 播放 ----------
function openPlayer(id) {
  var v = ALL.filter(function (x) { return x.id === id; })[0];
  if (!v) return;
  var isDirect = /\.(mp4|webm|m4v|mov|ogv)(\?.*)?$/i.test(v.link || '');
  var box = $('player-box');
  if (isDirect) {
    box.innerHTML = '<video controls autoplay playsinline src="' + esc(v.link) + '"></video>';
  } else {
    box.innerHTML = '<iframe src="' + esc(embedSrc(v.link)) + '" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>';
  }
  $('player-title').textContent = v.title || '';
  $('player-meta').textContent = (v.date || '') + (v.tag ? ' · ' + v.tag : '');
  $('player-desc').textContent = v.desc || '';
  $('player-page').style.display = '';
}
function closePlayer() {
  $('player-page').style.display = 'none';
  $('player-box').innerHTML = '';
}

// ---------- 底部导航与弹层 ----------
function tab(name) {
  view = name;
  document.querySelectorAll('.page').forEach(function (p) { p.style.display = 'none'; });
  document.querySelectorAll('.tabbar .tab').forEach(function (t) { t.classList.remove('active'); });
  $('page-' + name).style.display = '';
  var t = document.querySelector('.tab[data-tab="' + name + '"]');
  if (t) t.classList.add('active');
  if (name === 'cat') renderCat();
}
function openSubmit() { $('submit-mask').style.display = ''; }
function closeSubmit() { $('submit-mask').style.display = 'none'; }

// ---------- 事件 ----------
$('search-input').addEventListener('input', function () {
  if (view === 'cat') { renderCat(); } else { renderHome(); }
});
$('auth-btn').addEventListener('click', doAuth);
$('auth-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });
document.querySelector('.login-tabs').addEventListener('click', function (e) {
  var d = e.target.closest('div');
  if (!d) return;
  switchAuth(d.textContent.indexOf('注册') >= 0 ? 'register' : 'login');
});
$('logout-btn').addEventListener('click', logout);

// ---------- 启动 ----------
switchAuth('login');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/app/sw.js').catch(function () {});
}