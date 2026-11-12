/* Survivor league front end. Plain JavaScript, no build step. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var S = { me: null, league: 'Survivor League', nextSeason: null, skew: 0, timer: null };
  var TEAM = {};

  // ---------- helpers
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    });
    (function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    })(kids);
    return n;
  }
  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && S.me) { S.me = null; route(); }
        if (!r.ok) { var e = new Error(data.error || 'That did not work. Try again.'); e.status = r.status; throw e; }
        return data;
      });
    }, function () { throw new Error('No connection to the league site. Check your signal and try again.'); });
  }
  var toastTimer;
  function toast(msg, isBad) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show' + (isBad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, isBad ? 5000 : 2600);
  }
  var nowMs = function () { return Date.now() + S.skew; };
  var fmtDay = function (ms) { return new Date(ms).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }); };
  var fmtTime = function (ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  var fmtShort = function (ms) { return new Date(ms).toLocaleDateString([], { weekday: 'short' }) + ' ' + fmtTime(ms); };
  var fmtStamp = function (ms) { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  function countdown(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'less than a minute';
    if (m < 60) return m + ' min';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + ' hr ' + (m % 60) + ' min';
    var d = Math.floor(hr / 24);
    return d + (d === 1 ? ' day ' : ' days ') + (hr % 24) + ' hr';
  }
  var signed = function (n) { return (n > 0 ? '+' : '') + n; };
  var abbr = function (team) { return team ? (TEAM[team] ? TEAM[team].abbr : team) : 'None'; };
  function setTeams(list) { (list || []).forEach(function (t) { TEAM[t.name] = t; }); }

  // ---------- shell
  function shell(active, content) {
    clearInterval(S.timer);
    document.title = S.league;
    var links = [['#/', 'This week', 'week'], ['#/standings', 'Standings', 'standings'], ['#/picks', 'All picks', 'picks'], ['#/squares', 'Squares', 'squares']];
    if (S.me && S.me.role === 'manager') links.push(['#/manager', 'Manager', 'manager']);
    if (S.me && S.me.role === 'support') links.push(['#/activity', 'Activity', 'activity']);
    links.push(['#/account', 'Account', 'account']);
    app.replaceChildren(
      el('header', { class: 'top' }, el('div', { class: 'top-in' }, [
        el('h1', { class: 'league', text: S.league }),
        el('p', { class: 'who', text: S.me ? 'Logged in as ' + S.me.name : '' }),
        el('div', { class: 'hash' })
      ])),
      S.me ? el('div', { class: 'navwrap' }, el('nav', { class: 'nav' }, links.map(function (l) {
        return el('a', { href: l[0], class: l[2] === active ? 'on' : null, text: l[1] });
      }))) : null,
      el('main', {}, content)
    );
  }
  var loading = function (active) { shell(active, el('p', { class: 'boot', text: 'Loading…' })); };
  function failed(active, e) {
    shell(active, el('div', { class: 'card' }, [
      el('p', { text: e.message }),
      el('button', { class: 'btn', text: 'Try again', onclick: route })
    ]));
  }

  // ---------- log in and first-time setup
  function viewLogin() {
    var err = el('p', { class: 'err' });
    var user = el('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', required: true });
    var pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
    var btn = el('button', { class: 'btn', type: 'submit', text: 'Log in' });
    shell('', el('form', {
      class: 'card login', onsubmit: function (ev) {
        ev.preventDefault(); err.textContent = ''; btn.disabled = true;
        api('POST', '/api/login', { username: user.value, password: pass.value }).then(function (d) {
          S.me = d.me; if (location.hash.indexOf('#/setup') === 0) location.hash = '#/'; else route();
        }).catch(function (e) { err.textContent = e.message; btn.disabled = false; });
      }
    }, [
      el('h2', { text: 'Log in to make your pick' }),
      el('label', { class: 'f' }, ['Your name, as it appears in the standings', user]),
      el('label', { class: 'f' }, ['Password', pass]),
      err, btn,
      el('p', { class: 'note', text: 'First time here? Open the setup link the league manager sent you to choose a password.' }),
      el('p', { class: 'note' }, ['Not in the league yet? ', el('a', { href: '#/join', text: 'Sign up for next season' })]),
      el('p', { class: 'note' }, ['Here for the Super Bowl squares? ', el('a', { href: '#/squares', text: 'Open the squares board' })])
    ]));
  }

  // ---------- sign up for next season (no login needed)
  function viewJoin() {
    var year = S.nextSeason ? S.nextSeason + ' ' : 'next ';
    var err = el('p', { class: 'err' });
    var name = el('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '40' });
    var email = el('input', { type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: '80' });
    var phone = el('input', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: '30' });
    var trap = el('input', { type: 'text', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var trapWrap = el('div', { hidden: true }, trap);
    var btn = el('button', { class: 'btn', type: 'submit', text: 'Put me on the list' });
    shell('', el('form', {
      class: 'card login', onsubmit: function (ev) {
        ev.preventDefault(); err.textContent = ''; btn.disabled = true;
        api('POST', '/api/signup', { name: name.value, email: email.value, phone: phone.value, website: trap.value }).then(function (r) {
          shell('', el('div', { class: 'card login' }, [
            el('h2', { text: r.already ? 'You are already on the list' : 'You are on the list' }),
            el('p', { text: 'The league manager will contact you before the ' + year + 'season starts with how to join and how to log in.' }),
            el('a', { class: 'btn quiet', href: '#/', text: 'Back to log in' })
          ]));
        }).catch(function (e) { err.textContent = e.message; btn.disabled = false; });
      }
    }, [
      el('h2', { text: 'Join for the ' + year + 'season' }),
      el('p', { class: 'sub', text: 'New to ' + S.league + '? Leave your name and a way to reach you. Only the league managers see this.' }),
      el('label', { class: 'f' }, ['Your name', name]),
      el('label', { class: 'f' }, ['Email', email]),
      el('label', { class: 'f' }, ['Phone number', phone]),
      el('p', { class: 'sub', text: 'Fill in at least one of the two.' }),
      trapWrap, err, btn,
      el('p', { class: 'note' }, ['Already playing? ', el('a', { href: '#/', text: 'Log in' })])
    ]));
  }

  function viewSetup(token) {
    loading('');
    api('GET', '/api/setup/' + encodeURIComponent(token)).then(function (d) {
      S.league = d.league;
      var err = el('p', { class: 'err' });
      var p1 = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '6' });
      var p2 = el('input', { type: 'password', autocomplete: 'new-password', required: true });
      var btn = el('button', { class: 'btn', type: 'submit', text: 'Save password and log in' });
      shell('', el('form', {
        class: 'card login', onsubmit: function (ev) {
          ev.preventDefault(); err.textContent = '';
          if (p1.value !== p2.value) { err.textContent = 'The two passwords do not match.'; return; }
          btn.disabled = true;
          api('POST', '/api/setup/' + encodeURIComponent(token), { password: p1.value }).then(function (r) {
            S.me = r.me; location.hash = '#/';
          }).catch(function (e) { err.textContent = e.message; btn.disabled = false; });
        }
      }, [
        el('h2', { text: 'Welcome, ' + d.name }),
        el('p', { class: 'sub', text: 'Choose a password. After this you log in with your name (' + d.name + ') and this password.' }),
        el('label', { class: 'f' }, ['Password, at least 6 characters', p1]),
        el('label', { class: 'f' }, ['Type it again', p2]),
        err, btn
      ]));
    }).catch(function (e) {
      shell('', el('div', { class: 'card login' }, [
        el('h2', { text: 'This link does not work' }), el('p', { text: e.message }),
        el('a', { class: 'btn', href: '#/', text: 'Go to log in' })
      ]));
    });
  }

  // ---------- this week
  function weekBar(week, max, base) {
    var sel = el('select', { 'aria-label': 'Week', onchange: function () { location.hash = base + sel.value; } });
    for (var w = 1; w <= max; w++) sel.appendChild(el('option', { value: String(w), text: 'Week ' + w, selected: w === week }));
    return el('div', { class: 'weekbar' }, [
      el('button', { class: 'step', 'aria-label': 'Previous week', text: '‹', disabled: week <= 1, onclick: function () { location.hash = base + (week - 1); } }),
      el('h2', { text: 'Week ' + week }),
      sel,
      el('button', { class: 'step', 'aria-label': 'Next week', text: '›', disabled: week >= max, onclick: function () { location.hash = base + (week + 1); } })
    ]);
  }

  function spreadFor(g, team) {
    if (g.line === null || g.line === undefined) return null;
    if (g.line === 0 || !g.fav) return 'Pick’em';
    return (g.fav === team ? '−' : '+') + g.line;
  }

  function viewWeek(weekParam) {
    if (!app.querySelector('.weekbar')) loading('week');
    api('GET', '/api/state' + (weekParam ? '?week=' + weekParam : '')).then(function (st) {
      S.skew = st.now - Date.now(); S.league = st.league; S.me = st.me; setTeams(st.teams);
      drawWeek(st);
      clearInterval(S.timer);
      var ticks = 0;
      S.timer = setInterval(function () {
        if (document.hidden) return;
        if (++ticks % 3 === 0) viewWeek(weekParam); else drawWeek(st);
      }, 20000);
    }).catch(function (e) { if (e.status !== 401) failed('week', e); });
  }

  function drawWeek(st) {
    var t = nowMs();
    var week = st.week;
    var mine = st.myPicks.filter(function (p) { return p.week === week; })[0];
    var usedIn = {};
    st.myPicks.forEach(function (p) { if (p.team && p.week !== week) usedIn[p.team] = p.week; });
    var isLocked = function (g) { return g.locked || t >= g.lockAt; };
    var open = st.games.filter(function (g) { return !isLocked(g); });
    var myGame = mine && mine.team ? st.games.filter(function (g) { return g.home === mine.team || g.away === mine.team; })[0] : null;
    var myLocked = st.myPickLocked || (myGame ? isLocked(myGame) : false);

    function choose(team) {
      api('PUT', '/api/picks/' + week, { team: team }).then(function () {
        toast('Week ' + week + ' pick saved: ' + team);
        viewWeek(week);
      }).catch(function (e) { toast(e.message, true); viewWeek(week); });
    }
    function clearPick() {
      api('DELETE', '/api/picks/' + week).then(function () { toast('Week ' + week + ' pick removed'); viewWeek(week); })
        .catch(function (e) { toast(e.message, true); });
    }

    // banner
    var banner;
    if (!st.me.isPlayer) {
      banner = el('div', { class: 'mine' }, [el('strong', { text: 'Manager account' }),
        el('p', { text: 'This login runs the league and does not make picks. Use the Manager tab to enter or fix picks.' })]);
    } else if (mine) {
      var lines = [];
      if (mine.result) {
        var word = mine.result === 'W' ? 'Won' : mine.result === 'L' ? 'Lost' : 'Tied';
        lines.push(word + (mine.points ? ' by ' + Math.abs(mine.points) : '') + ': ' + signed(mine.points) + ' points' + (mine.note && !mine.team ? ' (' + mine.note + ')' : ''));
      } else if (myLocked) lines.push('Locked. It scores when the game ends.');
      else if (myGame) lines.push('Tap another team to switch, or tap your team again to remove it. Open until ' + fmtShort(myGame.lockAt) + ', ' + st.lockMinutes + ' minutes before kickoff.');
      banner = el('div', { class: 'mine set' }, [
        el('strong', { text: 'Your Week ' + week + ' pick: ' + (mine.team || 'none') }),
        lines.map(function (l) { return el('p', { text: l }); }),
        !myLocked ? el('button', { class: 'linkbtn', text: 'Remove this pick', onclick: clearPick }) : null
      ]);
    } else if (open.length) {
      var first = open[0];
      banner = el('div', { class: 'mine' }, [el('strong', { text: 'No Week ' + week + ' pick yet' }),
        el('p', { text: 'Tap a team below. The next game locks in ' + countdown(first.lockAt - t) + ' (' + fmtShort(first.lockAt) + ').' })]);
    } else if (st.games.length) {
      banner = el('div', { class: 'mine' }, [el('strong', { text: 'No pick was made for Week ' + week }),
        el('p', { text: 'Every game is locked. The league manager decides how a missed week is scored.' })]);
    }

    var body = [weekBar(week, st.weeks, '#/week/'), banner];
    if (!st.games.length) {
      body.push(el('div', { class: 'card' }, el('p', { text: st.feedOk ? 'No games are listed for this week yet.' : 'The schedule could not be loaded right now. Try again in a minute.' })));
    }
    var lastDay = '';
    st.games.forEach(function (g) {
      var day = fmtDay(g.kickoff);
      if (day !== lastDay) { body.push(el('h3', { class: 'day', text: day })); lastDay = day; }
      var locked = isLocked(g);
      var started = g.state !== 'pre';
      var left = g.lockAt - t;
      var lockText = locked ? (started ? g.statusText : 'Locked') : 'Locks in ' + countdown(left);

      function side(team, score, otherScore, where) {
        var info = TEAM[team] || { abbr: team, loc: '' };
        var picked = mine && mine.team === team;
        var used = usedIn[team];
        var sp = spreadFor(g, team);
        var canUndo = picked && !myLocked && !locked;
        var disabled = !st.me.isPlayer || locked || myLocked || (!!used && !picked) || (picked && !canUndo);
        var tag = canUndo ? 'Tap again to remove' : picked ? '' : used ? 'Used in Week ' + used : locked ? '' : myLocked ? '' : 'Tap to pick';
        var b = el('button', {
          class: 'side' + (picked ? ' picked' : '') + (used ? ' used' : '') + (locked ? ' shut' : '') + (g.completed && score > otherScore ? ' won' : ''),
          disabled: disabled, type: 'button',
          'aria-label': (picked ? 'Your pick: ' : 'Pick ') + info.loc + ' ' + team + (sp ? ', spread ' + sp : '') + (used ? ', already used in Week ' + used : '') + (canUndo ? '. Tap to remove this pick' : ''),
          onclick: function () { if (picked) clearPick(); else choose(team); }
        }, [
          el('span', { class: 'abbr', text: info.abbr }),
          el('span', { class: 'nm' }, [el('b', { text: team }), el('small', { text: info.loc })]),
          el('span', { class: 'line' }, [
            started && score !== null ? el('span', { class: 'score', text: String(score) }) : el('span', { text: sp || 'No line yet' }),
            el('span', { class: 'tag', text: started && sp ? 'Line ' + sp : tag })
          ])
        ]);
        b.style.setProperty('--team', info.color || '#5B6B62');
        return b;
      }

      body.push(el('div', { class: 'game' }, [
        el('div', { class: 'game-meta' }, [
          el('span', { text: 'Kickoff ' + fmtTime(g.kickoff) }),
          el('span', { class: 'lock' + (!locked && left < 3600000 ? ' soon' : ''), text: lockText })
        ]),
        el('div', { class: 'sides' }, [
          side(g.away, g.awayScore, g.homeScore, 'away'),
          el('div', { class: 'at' }, el('span', { text: 'at' })),
          side(g.home, g.homeScore, g.awayScore, 'home')
        ]),
        g.overUnder !== null && g.overUnder !== undefined ? el('div', { class: 'game-foot', text: 'Over/under ' + g.overUnder }) : null
      ]));
    });
    if (st.byes.length) body.push(el('p', { class: 'note', text: 'On bye this week: ' + st.byes.join(', ') + '.' }));
    var src = st.games.filter(function (g) { return g.oddsProvider; })[0];
    if (src) body.push(el('p', { class: 'note', text: 'Point spreads are the ' + src.oddsProvider + ' lines published by ESPN. They update until kickoff, then freeze. A minus sign marks the favorite. Times are shown in your local time.' }));
    shell('week', body);
  }

  // ---------- standings
  function viewStandings() {
    loading('standings');
    api('GET', '/api/standings').then(function (d) {
      S.me = d.me;
      var cur = d.currentWeek;
      var rows = d.rows.map(function (r) {
        var p = r.picks[cur];
        var status = !p ? el('span', { class: 'dim', text: 'No pick yet' })
          : p.hidden ? el('span', { class: 'pill', text: 'Picked, hidden' })
            : el('span', { text: (p.team || 'No pick') + (p.result ? ' ' + signed(p.points) : '') });
        return el('tr', { class: r.id === d.me.id ? 'me' : null }, [
          el('td', { class: 'rank', text: String(r.rank) }),
          el('td', {}, [r.name, r.id === d.me.id ? el('span', { class: 'you', text: 'You' }) : null]),
          el('td', { class: 'num', text: r.wins + '-' + r.losses + (r.ties ? '-' + r.ties : '') }),
          el('td', { class: 'num pts' + (r.points < 0 ? ' neg' : ''), text: String(r.points) }),
          el('td', {}, status)
        ]);
      });
      var mineRow = d.rows.filter(function (r) { return r.id === d.me.id; })[0];
      var tied = mineRow ? d.rows.filter(function (r) { return r.rank === mineRow.rank; }).length > 1 : false;
      var ord = function (n) { var t = n % 100, o = n % 10; return n + (t > 10 && t < 14 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th'); };
      shell('standings', [
        el('h2', { text: 'Standings' }),
        el('p', { class: 'sub', text: 'Fewest losses first, then most points. Points are the margin of each win, minus the margin of each loss.' }),
        mineRow ? el('div', { class: 'mine set spot' }, [
          el('strong', { text: 'You are ' + (tied ? 'tied for ' : '') + ord(mineRow.rank) + ' of ' + d.rows.length }),
          el('p', { text: mineRow.wins + ' wins, ' + mineRow.losses + (mineRow.losses === 1 ? ' loss, ' : ' losses, ') + mineRow.points + ' points' }),
          el('button', { class: 'linkbtn', text: 'Jump to my row', onclick: function () {
            var row = app.querySelector('tr.me');
            if (row) row.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          } })
        ]) : null,
        el('div', { class: 'tablewrap', style: null }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Rank' }), el('th', { text: 'Player' }), el('th', { class: 'num', text: 'W-L' }), el('th', { class: 'num', text: 'Points' }), el('th', { text: 'Week ' + cur })])),
          el('tbody', {}, rows)
        ])),
        el('p', { class: 'note', text: 'Nobody can see another player’s pick, league managers included, until that game locks 5 minutes before kickoff.' })
      ]);
      app.querySelector('.tablewrap').style.marginTop = '12px';
    }).catch(function (e) { if (e.status !== 401) failed('standings', e); });
  }

  // ---------- everyone's picks, week by week
  function viewGrid() {
    loading('picks');
    Promise.all([api('GET', '/api/standings'), Object.keys(TEAM).length ? null : api('GET', '/api/state')]).then(function (res) {
      var d = res[0];
      if (res[1]) setTeams(res[1].teams);
      S.me = d.me;
      var closed = {};
      d.closedWeeks.forEach(function (w) { closed[w] = true; });
      var head = [el('th', { text: 'Player' })];
      for (var w = 1; w <= d.weeks; w++) head.push(el('th', { class: w === d.currentWeek ? 'cur' : null, text: 'Wk ' + w }));
      var rows = d.rows.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (r) {
        var tds = [el('td', {}, [r.name, r.id === d.me.id ? el('span', { class: 'you', text: 'You' }) : null])];
        for (var w = 1; w <= d.weeks; w++) {
          var p = r.picks[w], c;
          if (!p) c = closed[w] ? el('span', { class: 'cell miss', title: 'No pick made', text: 'None' }) : el('span', { class: 'dim', text: '' });
          else if (p.hidden) c = el('span', { class: 'cell open', title: 'Picked. Hidden until the game locks.', text: 'In' });
          else c = el('span', { class: 'cell ' + (p.result || 'open'), title: (p.team || 'No pick') + (p.note ? ' (' + p.note + ')' : '') },
            [abbr(p.team), p.points !== null && p.points !== undefined ? el('small', { text: signed(p.points) }) : null]);
          tds.push(el('td', {}, c));
        }
        return el('tr', { class: r.id === d.me.id ? 'me' : null }, tds);
      });
      shell('picks', [
        el('h2', { text: 'All picks' }),
        el('p', { class: 'sub', text: 'Green is a win, red is a loss, with the points under the team. “In” means a pick is made but hidden until its game locks. Swipe sideways for later weeks.' }),
        el('div', { class: 'tablewrap' }, el('table', { class: 'grid' }, [el('thead', {}, el('tr', {}, head)), el('tbody', {}, rows)]))
      ]);
      app.querySelector('.tablewrap').style.marginTop = '12px';
    }).catch(function (e) { if (e.status !== 401) failed('picks', e); });
  }

  // ---------- account
  function viewAccount() {
    var err = el('p', { class: 'err' });
    var cur = el('input', { type: 'password', autocomplete: 'current-password', required: true });
    var p1 = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '6' });
    shell('account', [
      el('h2', { text: 'Account' }),
      el('div', { class: 'card' }, [
        el('p', { text: S.me.name + (S.me.role === 'manager' ? ', league manager' : S.me.role === 'support' ? ', support (can read the activity log)' : '') }),
        el('button', { class: 'btn quiet', text: 'Log out', onclick: function () {
          api('POST', '/api/logout').then(function () { S.me = null; location.hash = '#/'; route(); });
        } })
      ]),
      el('form', { class: 'card', onsubmit: function (ev) {
        ev.preventDefault(); err.textContent = '';
        api('POST', '/api/password', { current: cur.value, password: p1.value }).then(function () {
          cur.value = ''; p1.value = ''; toast('Password changed');
        }).catch(function (e) { err.textContent = e.message; });
      } }, [
        el('h3', { text: 'Change password' }),
        el('label', { class: 'f' }, ['Current password', cur]),
        el('label', { class: 'f' }, ['New password, at least 6 characters', p1]),
        err, el('button', { class: 'btn', type: 'submit', text: 'Change password' })
      ])
    ]);
    app.querySelector('form h3').style.marginTop = '0';
  }

  // ---------- manager
  function managerTabs(on) {
    return el('div', { class: 'tabs' }, [['#/manager', 'Picks', 'picks'], ['#/manager/players', 'Players', 'players'], ['#/manager/signups', 'Sign-ups', 'signups'], ['#/manager/squares', 'Squares', 'squares'], ['#/manager/log', 'Activity', 'log']]
      .map(function (t) { return el('a', { href: t[0], class: t[2] === on ? 'on' : null, text: t[1] }); }));
  }

  function viewManagerPicks(weekParam) {
    if (!app.querySelector('.mrow')) loading('manager');
    api('GET', '/api/state' + (weekParam ? '?week=' + weekParam : '')).then(function (st) {
      return api('GET', '/api/standings').then(function (sd) { return [st, sd]; });
    }).then(function (r) {
      var st = r[0], sd = r[1];
      setTeams(st.teams); S.skew = st.now - Date.now();
      var week = st.week;
      var playing = [];
      st.games.forEach(function (g) { playing.push(g.away, g.home); });
      playing.sort();
      var onlyMissing = S.onlyMissing;
      var players = sd.rows.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
      var have = players.filter(function (p) { return p.picks[week]; }).length;
      var reload = function () { viewManagerPicks(week); };
      var save = function (id, body, msg) {
        return api('PUT', '/api/admin/picks/' + id + '/' + week, body).then(function () { toast(msg); reload(); })
          .catch(function (e) { toast(e.message, true); reload(); });
      };

      var rows = players.filter(function (p) { return !onlyMissing || !p.picks[week]; }).map(function (p) {
        var pick = p.picks[week];
        var used = {};
        Object.keys(p.picks).forEach(function (w) { if (Number(w) !== week && p.picks[w].team) used[p.picks[w].team] = w; });
        var sel = el('select', { 'aria-label': 'Pick for ' + p.name });
        sel.appendChild(el('option', { value: '', text: pick && pick.hidden ? 'Hidden until the game locks' : pick && !pick.team ? 'No team (scored by hand)' : 'Choose a team' }));
        (playing.length ? playing : Object.keys(TEAM).sort()).forEach(function (tm) {
          sel.appendChild(el('option', { value: tm, text: tm + (used[tm] ? ' (used Week ' + used[tm] + ')' : ''), disabled: !!used[tm], selected: pick && pick.team === tm }));
        });
        sel.addEventListener('change', function () { if (sel.value) save(p.id, { team: sel.value }, p.name + ': ' + sel.value); });

        var state = !pick ? el('span', { class: 'pill warn', text: 'No pick' })
          : pick.hidden ? el('span', { class: 'pill ok', text: 'Picked, hidden' })
          : pick.result ? el('span', { class: 'pill ' + (pick.result === 'W' ? 'ok' : ''), text: pick.result + ' ' + signed(pick.points) + (pick.manual ? ', by hand' : '') })
            : el('span', { class: 'pill', text: 'Waiting for final' });

        var pts = el('input', { type: 'number', step: '1', placeholder: 'Points', 'aria-label': 'Points for ' + p.name, value: pick && pick.manual && pick.points !== null ? String(pick.points) : '' });
        var note = el('input', { type: 'text', maxlength: '120', placeholder: 'Note, for example Missed pick', 'aria-label': 'Note', value: pick && pick.manual && pick.note ? pick.note : '' });
        var hand = el('div', { class: 'hand row', hidden: true }, [
          pts, note,
          el('button', { class: 'btn small', text: 'Save score', onclick: function () {
            if (pts.value === '') { toast('Enter the points, for example -10 for a 10 point loss.', true); return; }
            save(p.id, { team: sel.value || null, points: Number(pts.value), note: note.value }, p.name + ': scored ' + signed(Number(pts.value)));
          } }),
          el('span', { class: 'sub', text: 'A negative number counts as a loss. Leave the team empty for a missed pick.' })
        ]);
        return el('div', { class: 'mrow' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'name', text: p.name }), state, sel,
            el('button', { class: 'btn small quiet', text: 'Score by hand', onclick: function () { hand.hidden = !hand.hidden; if (!hand.hidden) pts.focus(); } }),
            pick ? el('button', { class: 'btn small danger', text: 'Clear', onclick: function () {
              api('DELETE', '/api/admin/picks/' + p.id + '/' + week).then(function () { toast(p.name + ': pick cleared'); reload(); }).catch(function (e) { toast(e.message, true); });
            } }) : null
          ]),
          hand
        ]);
      });

      var filter = el('input', { type: 'checkbox', checked: !!onlyMissing, onchange: function () { S.onlyMissing = filter.checked; reload(); } });
      shell('manager', [
        managerTabs('picks'),
        weekBar(week, st.weeks, '#/manager/week/'),
        el('p', { class: 'sub', text: have + ' of ' + players.length + ' players have a Week ' + week + ' pick. Choosing a team here saves right away, ignores the lock, and scores itself from the final score. A pick a player has already made stays hidden from everyone, managers included, until its game locks; choosing a team for that player replaces it.' }),
        el('div', { class: 'row' }, [
          el('label', {}, [filter, ' Show only players without a pick']),
          el('button', { class: 'btn small quiet', text: 'Refresh scores and spreads', onclick: function () {
            api('POST', '/api/admin/refresh', { week: week }).then(function () { toast('Week ' + week + ' refreshed'); reload(); }).catch(function (e) { toast(e.message, true); });
          } })
        ]),
        rows.length ? rows : el('div', { class: 'card' }, el('p', { text: 'Everyone has a pick for this week.' }))
      ]);
      var rowEls = app.querySelectorAll('main > .row');
      if (rowEls[0]) rowEls[0].style.margin = '10px 0 12px';
    }).catch(function (e) { if (e.status !== 401) failed('manager', e); });
  }

  function setupLink(token) { return location.origin + '/#/setup/' + token; }
  function copy(text, msg) {
    var done = function () { toast(msg || 'Copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt ? showCopy(text) : null; });
    else showCopy(text);
  }
  function showCopy(text) {
    var box = el('textarea', { readonly: true });
    box.value = text;
    var card = el('div', { class: 'card' }, [el('p', { text: 'Select and copy this:' }), box]);
    app.querySelector('main').prepend(card);
    box.focus(); box.select();
  }

  function viewManagerPlayers() {
    loading('manager');
    api('GET', '/api/admin/players').then(function (d) {
      var reload = viewManagerPlayers;
      var patch = function (id, body, msg) {
        return api('PATCH', '/api/admin/players/' + id, body).then(function () { toast(msg); reload(); })
          .catch(function (e) { toast(e.message, true); reload(); });
      };
      var pending = d.players.filter(function (p) { return p.active && p.setupToken; });
      var newName = el('input', { type: 'text', placeholder: 'Name, for example Pat M.', maxlength: '40', 'aria-label': 'New player name' });

      var rows = d.players.map(function (p) {
        var paid = el('input', { type: 'checkbox', checked: p.paid, 'aria-label': 'Paid', onchange: function () { patch(p.id, { paid: paid.checked }, p.name + (paid.checked ? ': paid' : ': not paid')); } });
        var mgr = el('select', { 'aria-label': 'Role for ' + p.name }, [['player', 'Player'], ['support', 'Support: reads the activity log'], ['manager', 'League manager']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: p.role === o[0] }); }));
        mgr.addEventListener('change', function () { patch(p.id, { role: mgr.value }, p.name + ': ' + mgr.options[mgr.selectedIndex].text); });
        var login = !p.active ? el('span', { class: 'pill', text: 'Removed' })
          : p.hasPassword ? el('span', { class: 'pill ok', text: 'Set up' })
            : el('button', { class: 'btn small', text: 'Copy setup link', onclick: function () { copy(setupLink(p.setupToken), 'Setup link for ' + p.name + ' copied'); } });
        return el('tr', {}, [
          el('td', {}, [el('div', { text: p.name }), el('small', { class: 'dim', text: p.isPlayer ? '' : 'Manages only, no picks' })]),
          el('td', {}, p.isPlayer ? paid : null),
          el('td', {}, mgr),
          el('td', {}, login),
          el('td', {}, el('div', { class: 'row' }, [
            p.active && p.id !== S.me.id ? el('button', { class: 'btn small quiet', text: p.hasPassword ? 'Reset password' : 'New link', onclick: function () {
              api('POST', '/api/admin/players/' + p.id + '/reset').then(function (r) { copy(setupLink(r.setupToken), 'New setup link for ' + p.name + ' copied'); reload(); }).catch(function (e) { toast(e.message, true); });
            } }) : null,
            el('button', { class: 'btn small quiet', text: 'Rename', onclick: function () {
              var input = el('input', { type: 'text', value: p.name, maxlength: '40', 'aria-label': 'New name' });
              var cell = this.closest('tr').firstChild;
              cell.replaceChildren(input, el('button', { class: 'btn small', text: 'Save', onclick: function () { patch(p.id, { name: input.value }, 'Renamed'); } }));
              input.focus();
            } }),
            p.id !== S.me.id ? el('button', { class: 'btn small ' + (p.active ? 'danger' : 'quiet'), text: p.active ? 'Remove' : 'Restore', onclick: function () {
              patch(p.id, { active: !p.active }, p.name + (p.active ? ' removed' : ' restored'));
            } }) : null
          ]))
        ]);
      });

      shell('manager', [
        managerTabs('players'),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Send out setup links' }),
          el('p', { class: 'sub', text: pending.length ? pending.length + ' players have not chosen a password yet. Each player has a personal link. Send each person only their own link; opening it lets them choose a password.' : 'Every player has chosen a password.' }),
          pending.length ? el('button', { class: 'btn', text: 'Copy all ' + pending.length + ' names and links', onclick: function () {
            copy(pending.map(function (p) { return p.name + ': ' + setupLink(p.setupToken); }).join('\n'), 'List copied');
          } }) : null
        ]),
        el('form', { class: 'card row', onsubmit: function (ev) {
          ev.preventDefault();
          api('POST', '/api/admin/players', { name: newName.value }).then(function () { toast('Player added'); reload(); }).catch(function (e) { toast(e.message, true); });
        } }, [newName, el('button', { class: 'btn', type: 'submit', text: 'Add player' })]),
        el('div', { class: 'tablewrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Player' }), el('th', { text: 'Paid' }), el('th', { text: 'Role' }), el('th', { text: 'Login' }), el('th', { text: '' })])),
          el('tbody', {}, rows)
        ]))
      ]);
      var h3 = app.querySelector('.card h3'); if (h3) h3.style.marginTop = '0';
    }).catch(function (e) { if (e.status !== 401) failed('manager', e); });
  }

  function viewManagerSignups() {
    loading('manager');
    api('GET', '/api/admin/signups').then(function (d) {
      var link = location.origin + '/#/join';
      var rows = d.signups.map(function (s) {
        return el('tr', {}, [
          el('td', { class: 'dim', text: fmtStamp(s.created_at) }),
          el('td', { text: s.name }), el('td', { text: s.email || '' }), el('td', { text: s.phone || '' }), el('td', { text: s.note || '' }),
          el('td', {}, el('button', { class: 'btn small danger', text: 'Remove', onclick: function () {
            api('DELETE', '/api/admin/signups/' + s.id).then(function () { toast(s.name + ' removed from the list'); viewManagerSignups(); }).catch(function (e) { toast(e.message, true); });
          } }))
        ]);
      });
      var aName = el('input', { type: 'text', maxlength: '40', placeholder: 'Name', 'aria-label': 'Name', required: true });
      var aEmail = el('input', { type: 'email', maxlength: '80', placeholder: 'Email (optional)', 'aria-label': 'Email' });
      var aPhone = el('input', { type: 'tel', maxlength: '30', placeholder: 'Phone (optional)', 'aria-label': 'Phone' });
      var aNote = el('input', { type: 'text', maxlength: '160', placeholder: 'Note (optional)', 'aria-label': 'Note' });
      var addForm = el('form', { class: 'card', onsubmit: function (ev) {
        ev.preventDefault();
        api('POST', '/api/admin/signups', { name: aName.value, email: aEmail.value, phone: aPhone.value, note: aNote.value }).then(function () {
          toast(aName.value + ' added to the ' + d.nextSeason + ' list'); viewManagerSignups();
        }).catch(function (e) { toast(e.message, true); });
      } }, [
        el('h3', { text: 'Sign someone up yourself' }),
        el('p', { class: 'sub', text: 'For anyone who asks you to put them down. They go on the same list.' }),
        el('div', { class: 'row' }, [aName, aEmail, aPhone, aNote, el('button', { class: 'btn', type: 'submit', text: 'Add to the list' })])
      ]);
      shell('manager', [
        managerTabs('signups'),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Sign-ups for the ' + d.nextSeason + ' season' }),
          el('p', { class: 'sub', text: 'New people can put themselves on this list without a login. Share this link, or point them to “Sign up for next season” on the log-in page. Signing up does not add anyone to this season.' }),
          el('p', {}, el('b', { text: link })),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn small', text: 'Copy sign-up link', onclick: function () { copy(link, 'Sign-up link copied'); } }),
            d.signups.length ? el('button', { class: 'btn small quiet', text: 'Copy the list', onclick: function () {
              copy(d.signups.map(function (s) { return [s.name, s.email, s.phone, s.note].filter(Boolean).join(', '); }).join('\n'), 'List copied');
            } }) : null
          ])
        ]),
        addForm,
        el('div', { class: 'tablewrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Signed up' }), el('th', { text: 'Name' }), el('th', { text: 'Email' }), el('th', { text: 'Phone' }), el('th', { text: 'Note' }), el('th', { text: '' })])),
          el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: '6', class: 'dim', text: 'Nobody has signed up yet.' })))
        ]))
      ]);
      [].forEach.call(app.querySelectorAll('.card h3'), function (h) { h.style.marginTop = '0'; });
      app.querySelector('.card b').style.wordBreak = 'break-all';
      addForm.querySelector('.row').style.marginTop = '10px';
      app.querySelector('.tablewrap table').style.minWidth = '720px';
      [aName, aEmail, aPhone, aNote].forEach(function (i) { i.style.flex = '1 1 170px'; });
    }).catch(function (e) { if (e.status !== 401) failed('manager', e); });
  }

  // ---------- activity log: everything anyone does, with timestamps
  var LOG = { who: '', kind: '', rows: [], more: false };
  var KINDS = [['', 'Everything'], ['pick', 'Picks'], ['login', 'Log-ins and passwords'], ['manager', 'Manager changes'], ['squares', 'Squares'], ['signup', 'Sign-ups'], ['system', 'Daily update']];
  var fmtFull = function (ms) { return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }); };

  function viewManagerLog(append) {
    var isMgr = S.me.role === 'manager', tab = isMgr ? 'manager' : 'activity';
    if (!append && !app.querySelector('.logwrap')) loading(tab);
    var qs = '?kind=' + encodeURIComponent(LOG.kind) + '&who=' + encodeURIComponent(LOG.who) +
      (append && LOG.rows.length ? '&before=' + LOG.rows[LOG.rows.length - 1].ts : '');
    api('GET', '/api/admin/log' + qs).then(function (d) {
      LOG.rows = append ? LOG.rows.concat(d.log) : d.log;
      LOG.more = d.more;
      var who = el('input', { type: 'text', placeholder: 'Name', value: LOG.who, 'aria-label': 'Filter by name', maxlength: '40' });
      var kind = el('select', { 'aria-label': 'Filter by type' }, KINDS.map(function (k) { return el('option', { value: k[0], text: k[1], selected: k[0] === LOG.kind }); }));
      var apply = function () { LOG.who = who.value.trim(); LOG.kind = kind.value; viewManagerLog(); };
      kind.addEventListener('change', apply);
      var label = {}; KINDS.forEach(function (k) { label[k[0]] = k[1]; });
      shell(tab, [
        isMgr ? managerTabs('log') : el('h2', { text: 'Activity' }),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Daily update' }),
          el('p', { class: 'sub', text: 'Every day at ' + d.dailyHour + ':00 AM Eastern the program looks up the schedule, finds the final scores, and adds each win or loss margin to the standings. ' +
            (d.dailyAt ? 'Last run ' + fmtStamp(d.dailyAt) + ' your time: ' + d.dailySummary + '.' : 'It has not run yet.') }),
          d.canRun ? el('button', { class: 'btn small quiet', text: 'Run the daily update now', onclick: function () {
            this.disabled = true;
            api('POST', '/api/admin/daily-update').then(function (r) { toast('Daily update done: ' + r.summary); viewManagerLog(); }).catch(function (e) { toast(e.message, true); viewManagerLog(); });
          } }) : null
        ]),
        el('h3', { text: 'Activity log' }),
        el('p', { class: 'sub', text: 'Everything anyone does is recorded with the time: log-ins, picks made, changed or removed, sign-ups, squares, and every manager change. A team is shown here only after its game locks, the same as everywhere else.' + (isMgr ? '' : ' You can read this log but not change anything.') }),
        el('form', { class: 'row logfilter', onsubmit: function (ev) { ev.preventDefault(); apply(); } }, [
          who, kind, el('button', { class: 'btn small', type: 'submit', text: 'Filter' }),
          LOG.who || LOG.kind ? el('button', { class: 'btn small quiet', type: 'button', text: 'Show everything', onclick: function () { LOG.who = ''; LOG.kind = ''; viewManagerLog(); } }) : null
        ]),
        el('div', { class: 'tablewrap logwrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'When (your time)' }), el('th', { text: 'Who' }), el('th', { text: 'Type' }), el('th', { text: 'What happened' })])),
          el('tbody', {}, LOG.rows.length ? LOG.rows.map(function (l) {
            return el('tr', {}, [el('td', { class: 'dim when', text: fmtFull(l.ts) }), el('td', { text: l.actor }), el('td', {}, el('span', { class: 'pill', text: label[l.kind] || l.kind })), el('td', { text: l.action + (l.detail ? ': ' + l.detail : '') })]);
          }) : el('tr', {}, el('td', { colspan: '4', class: 'dim', text: 'Nothing recorded for this filter yet.' })))
        ])),
        LOG.more ? el('div', { class: 'row' }, el('button', { class: 'btn small quiet', type: 'button', text: 'Show older entries', onclick: function () { viewManagerLog(true); } })) : null
      ]);
      app.querySelector('.card h3').style.marginTop = '0';
      var b1 = app.querySelector('.card .btn'); if (b1) b1.style.marginTop = '10px';
      app.querySelector('.logfilter').style.margin = '10px 0';
      app.querySelector('.logwrap table').style.minWidth = '640px';
      var older = app.querySelector('main > .row:last-child'); if (older) older.style.marginTop = '12px';
    }).catch(function (e) { if (e.status !== 401) failed(tab, e); });
  }

  // ---------- Super Bowl squares (open to anyone with the link)
  var SQ = { picked: {}, name: '', contact: '', detail: null };
  var money = function (n) { return '$' + (n % 1 ? n.toFixed(2) : String(n)); };
  function initials(name) {
    var w = String(name).replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean);
    return (w.length > 1 ? w.map(function (x) { return x[0]; }).join('') : (w[0] || '?')).slice(0, 3).toUpperCase();
  }

  function viewSquares() {
    if (!app.querySelector('.board')) loading('squares');
    api('GET', '/api/squares').then(function (d) {
      S.league = d.league; if (d.me) S.me = d.me;
      drawSquares(d);
    }).catch(function (e) { failed('squares', e); });
  }

  function drawSquares(d) {
    var isMgr = S.me && S.me.role === 'manager';
    var winAt = {};
    d.winners.forEach(function (w) { if (w) (winAt[w.idx] = winAt[w.idx] || []).push(w.quarter); });
    Object.keys(SQ.picked).forEach(function (k) { if (d.squares[k] || !d.open) delete SQ.picked[k]; });
    var picked = Object.keys(SQ.picked).map(Number);
    var left = 100 - d.sold;

    var board = el('div', { class: 'board', role: 'grid', 'aria-label': 'Squares board' });
    board.appendChild(el('div', { class: 'bh corner' }));
    for (var c = 0; c < 10; c++) board.appendChild(el('div', { class: 'bh topd', text: d.cols ? String(d.cols[c]) : '?' }));
    for (var r = 0; r < 10; r++) {
      board.appendChild(el('div', { class: 'bh sided', text: d.rows ? String(d.rows[r]) : '?' }));
      for (var c2 = 0; c2 < 10; c2++) (function (idx) {
        var sq = d.squares[idx], sel = !!SQ.picked[idx], win = winAt[idx];
        var canPick = !sq && d.open;
        var label = 'Square ' + (idx + 1) + (sq ? ', ' + sq.name : canPick ? (sel ? ', selected' : ', open') : ', not sold');
        board.appendChild(el('button', {
          type: 'button', class: 'sq' + (sq ? ' taken' : '') + (sel ? ' sel' : '') + (win ? ' win' : '') + (SQ.detail === idx ? ' show' : ''),
          'aria-label': label, disabled: !sq && !canPick,
          text: sq ? initials(sq.name) : sel ? '✓' : '',
          onclick: function () {
            if (sq) { SQ.detail = SQ.detail === idx ? null : idx; }
            else if (SQ.picked[idx]) delete SQ.picked[idx]; else SQ.picked[idx] = true;
            drawSquares(d);
          }
        }));
      })(r * 10 + c2);
    }

    var status = d.cols ? 'The numbers are drawn and the board is closed.'
      : d.open ? (left ? left + ' of 100 squares left at ' + money(d.price) + ' each.' : 'All 100 squares are sold. The numbers are drawn next.')
        : 'The board is not open for buying right now.';
    var payoutLine = d.quarters.map(function (qn, i) { return qn + ' ' + d.payouts[i] + '%'; }).join(', ');

    var detail = null;
    if (SQ.detail !== null && d.squares[SQ.detail]) {
      var dsq = d.squares[SQ.detail], drow = Math.floor(SQ.detail / 10), dcol = SQ.detail % 10;
      detail = el('div', { class: 'card sqd' }, [
        el('b', { text: dsq.name }),
        el('span', { text: ' has square ' + (SQ.detail + 1) + (d.cols ? ': ' + d.top + ' ' + d.cols[dcol] + ', ' + d.side + ' ' + d.rows[drow] : ' (row ' + (drow + 1) + ', column ' + (dcol + 1) + ')') + '.' }),
        isMgr && !d.scores.some(function (s) { return s; }) ? el('button', { class: 'btn small danger', text: 'Release this square', onclick: function () {
          var i = SQ.detail; SQ.detail = null;
          api('DELETE', '/api/admin/squares/' + i).then(function () { toast('Square ' + (i + 1) + ' released'); viewSquares(); }).catch(function (e) { toast(e.message, true); viewSquares(); });
        } }) : null
      ]);
    }

    var form = null;
    if (d.open) {
      var err = el('p', { class: 'err' });
      var nm = el('input', { type: 'text', maxlength: '40', autocomplete: 'name', required: true, value: SQ.name || (S.me && S.me.isPlayer && !isMgr ? S.me.name : '') });
      var ct = el('input', { type: 'text', maxlength: '80', autocomplete: 'email', required: !isMgr, value: SQ.contact });
      nm.addEventListener('input', function () { SQ.name = nm.value; });
      ct.addEventListener('input', function () { SQ.contact = ct.value; });
      var btn = el('button', { class: 'btn', type: 'submit', disabled: !picked.length,
        text: picked.length ? 'Claim ' + picked.length + (picked.length === 1 ? ' square for ' : ' squares for ') + money(picked.length * d.price) : 'Tap squares on the board first' });
      form = el('form', { class: 'card', onsubmit: function (ev) {
        ev.preventDefault(); err.textContent = ''; btn.disabled = true;
        api('POST', '/api/squares/claim', { name: nm.value, contact: ct.value, squares: picked }).then(function (r) {
          SQ.picked = {}; SQ.name = nm.value; SQ.contact = ct.value;
          SQ.done = nm.value + ' now has ' + r.total + (r.total === 1 ? ' square' : ' squares') + '. Total owed to the league manager: ' + money(r.owes) + '.';
          toast(r.claimed + (r.claimed === 1 ? ' square claimed' : ' squares claimed')); viewSquares();
        }).catch(function (e) { err.textContent = e.message; btn.disabled = false; if (e.status === 409) { SQ.picked = {}; viewSquares(); toast(e.message, true); } });
      } }, [
        el('h3', { text: isMgr ? 'Add squares for someone' : 'Claim your squares' }),
        SQ.done ? el('p', { class: 'okmsg', text: SQ.done }) : null,
        el('p', { class: 'sub', text: (isMgr ? 'As league manager you can add squares for anyone; the limit does not apply. ' : '') + 'Tap open squares on the board, then fill this in.' + (d.limit && !isMgr ? ' Limit: ' + d.limit + ' per person.' : '') + ' Squares are paid to the league manager directly; this site does not take payments.' }),
        el('label', { class: 'f' }, [isMgr ? 'Their name' : 'Your name', nm]),
        el('label', { class: 'f' }, [isMgr ? 'Their email or phone (optional)' : 'Email or phone number', ct]),
        err, btn
      ]);
    }

    var results = d.quarters.map(function (qn, i) {
      var s = d.scores[i], w = d.winners[i];
      return el('tr', {}, [
        el('td', { text: qn }),
        el('td', { text: s ? d.top + ' ' + s.top + ', ' + d.side + ' ' + s.side : 'Not played yet' }),
        el('td', {}, w ? el('b', { text: w.name || 'Unsold square' }) : el('span', { class: 'dim', text: s ? 'Numbers not drawn' : '' })),
        el('td', { class: 'num', text: money(Math.round(d.pot * d.payouts[i]) / 100) })
      ]);
    });

    shell('squares', [
      el('h2', { text: 'Super Bowl squares' }),
      el('p', { class: 'sub', text: status + ' Pot so far: ' + money(d.pot) + '.' }),
      el('div', { class: 'boardwrap' }, [
        el('p', { class: 'axis', text: 'Across the top: ' + d.top + '. Down the side: ' + d.side + '.' }),
        board,
        el('p', { class: 'note', text: d.cols ? 'Your numbers are the digit above your square (' + d.top + ') and the digit to its left (' + d.side + '). Gold squares have won a quarter. Tap a square to see whose it is.'
          : 'The numbers 0 to 9 are drawn at random for the top and the side after buying closes, so every square has the same chance. Tap a taken square to see whose it is.' })
      ]),
      detail, form,
      el('h3', { text: 'Payouts and winners' }),
      el('p', { class: 'sub', text: 'Each quarter, the last digit of each team’s score picks the winning square. ' + payoutLine + ' of the pot.' }),
      el('div', { class: 'tablewrap' }, el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'When' }), el('th', { text: 'Score' }), el('th', { text: 'Winner' }), el('th', { class: 'num', text: 'Pays' })])),
        el('tbody', {}, results)
      ])),
      !S.me ? el('p', { class: 'note' }, ['In the survivor league? ', el('a', { href: '#/', text: 'Log in' })]) : null
    ]);
    board.style.setProperty('--n', '11');
    var tw = app.querySelector('.tablewrap'); tw.style.marginTop = '10px'; tw.querySelector('table').style.minWidth = '460px';
    var fh = app.querySelector('form.card h3'); if (fh) fh.style.marginTop = '0';
  }

  function viewManagerSquares() {
    loading('manager');
    api('GET', '/api/admin/squares').then(function (d) {
      var reload = viewManagerSquares;
      var call = function (method, url, body, msg) {
        return api(method, url, body).then(function () { toast(msg); reload(); }).catch(function (e) { toast(e.message, true); });
      };
      var link = location.origin + '/#/squares';
      var num = function (v, label, step) { return el('input', { type: 'number', step: step || '1', min: '0', value: String(v), 'aria-label': label }); };
      var price = num(d.price, 'Price per square', '0.01'), limit = num(d.limit, 'Limit per person');
      var pays = d.payouts.map(function (p, i) { return num(p, d.quarters[i] + ' percent'); });
      var top = el('input', { type: 'text', maxlength: '30', value: d.top, 'aria-label': 'Team across the top' });
      var side = el('input', { type: 'text', maxlength: '30', value: d.side, 'aria-label': 'Team down the side' });
      var open = el('input', { type: 'checkbox', checked: d.open || (!d.cols && false) });
      var anyScore = d.scores.some(function (s) { return s; });

      // two taps for the actions that cannot be undone
      function sure(text, cls, fn) {
        var b = el('button', { class: 'btn small ' + cls, type: 'button', text: text, onclick: function () {
          if (b.dataset.armed) return fn();
          b.dataset.armed = '1'; b.textContent = 'Tap again to confirm';
          setTimeout(function () { delete b.dataset.armed; b.textContent = text; }, 4000);
        } });
        return b;
      }

      var people = {};
      d.squares.forEach(function (s, i) {
        if (!s) return;
        var k = (s.name + '|' + s.contact).toLowerCase().replace(/[^a-z0-9|]/g, '');
        var p = people[k] = people[k] || { name: s.name, contact: s.contact, n: 0, paid: 0 };
        p.n++; if (s.paid) p.paid++;
      });
      var list = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var owed = list.reduce(function (a, p) { return a + (p.n - p.paid) * d.price; }, 0);

      var scoreRows = d.quarters.map(function (qn, i) {
        var s = d.scores[i], t = num(s ? s.top : '', d.top + ' score, ' + qn), sd = num(s ? s.side : '', d.side + ' score, ' + qn);
        return el('div', { class: 'row sc' }, [
          el('span', { class: 'name', text: qn }), el('label', {}, [d.top + ' ', t]), el('label', {}, [d.side + ' ', sd]),
          el('button', { class: 'btn small', type: 'button', text: 'Save', onclick: function () {
            if (t.value === '' || sd.value === '') { toast('Enter both scores.', true); return; }
            call('PUT', '/api/admin/squares/scores', { quarter: i, top: Number(t.value), side: Number(sd.value) }, qn + ' saved');
          } }),
          s ? el('button', { class: 'btn small quiet', type: 'button', text: 'Clear', onclick: function () { call('PUT', '/api/admin/squares/scores', { quarter: i, clear: true }, qn + ' cleared'); } }) : null,
          s ? el('span', { class: 'pill', text: s.manual ? 'Entered by hand' : 'From the schedule' }) : null
        ]);
      });

      shell('manager', [
        managerTabs('squares'),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Super Bowl squares' }),
          el('p', { class: 'sub', text: d.sold + ' of 100 sold. Pot ' + money(d.pot) + ', still owed ' + money(owed) + '. Anyone with this link can buy; no login needed.' }),
          el('p', {}, el('b', { text: link })),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn small', type: 'button', text: 'Copy the link', onclick: function () { copy(link, 'Squares link copied'); } }),
            el('a', { class: 'btn small quiet', href: '#/squares', text: 'Open the board' })
          ]),
          el('p', { class: 'sub', text: 'To add squares for someone, open the board while logged in as a manager, tap the squares and enter their name. To release one, tap it on the board.' })
        ]),
        el('form', { class: 'card', onsubmit: function (ev) {
          ev.preventDefault();
          call('PATCH', '/api/admin/squares/settings', { price: Number(price.value), limit: Number(limit.value), payouts: pays.map(function (p) { return Number(p.value); }), top: top.value, side: side.value, open: open.checked }, 'Squares settings saved');
        } }, [
          el('h3', { text: 'Settings' }),
          el('div', { class: 'row' }, [el('label', { class: 'f' }, ['Price per square ($)', price]), el('label', { class: 'f' }, ['Limit per person (0 = no limit)', limit])]),
          el('div', { class: 'row' }, d.quarters.map(function (qn, i) { return el('label', { class: 'f' }, [qn + ' (%)', pays[i]]); })),
          el('div', { class: 'row' }, [el('label', { class: 'f' }, ['Team across the top', top]), el('label', { class: 'f' }, ['Team down the side', side])]),
          d.cols ? el('p', { class: 'sub', text: 'Buying is closed because the numbers are drawn.' }) : el('label', {}, [open, ' Board is open for buying']),
          el('div', { class: 'row' }, el('button', { class: 'btn', type: 'submit', text: 'Save settings' }))
        ]),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Numbers' }),
          d.cols ? el('p', { class: 'sub', text: 'Drawn. Top: ' + d.cols.join(' ') + '. Side: ' + d.rows.join(' ') + '.' })
            : el('p', { class: 'sub', text: 'Drawing shuffles 0 to 9 for the top and the side, shows them to everyone, and closes buying. ' + (d.sold < 100 ? (100 - d.sold) + ' squares are still unsold.' : 'The board is full.') }),
          d.cols ? (anyScore ? null : sure('Clear the numbers', 'quiet', function () { call('POST', '/api/admin/squares/undraw', {}, 'Numbers cleared'); }))
            : sure('Draw the numbers', '', function () { call('POST', '/api/admin/squares/draw', {}, 'Numbers drawn'); })
        ]),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Scores' }),
          el('p', { class: 'sub', text: 'On game day the scores fill in from the schedule by themselves, once the team names match the two Super Bowl teams. You can also enter or correct them here; a score entered by hand is never overwritten.' }),
          scoreRows,
          el('div', { class: 'row' }, el('button', { class: 'btn small quiet', type: 'button', text: 'Get teams and scores from the schedule', onclick: function () {
            api('POST', '/api/admin/squares/sync', {}).then(function (r) { toast(r.matched ? 'Teams and scores updated' : 'Found the game, but the team names here do not match it', !r.matched); reload(); }).catch(function (e) { toast(e.message, true); });
          } }))
        ]),
        el('h3', { text: 'Buyers' }),
        el('div', { class: 'tablewrap' }, el('table', {}, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Email or phone' }), el('th', { class: 'num', text: 'Squares' }), el('th', { class: 'num', text: 'Total' }), el('th', { text: 'Paid' })])),
          el('tbody', {}, list.length ? list.map(function (p) {
            var all = p.paid === p.n;
            return el('tr', {}, [
              el('td', { text: p.name }), el('td', { text: p.contact }), el('td', { class: 'num', text: String(p.n) }), el('td', { class: 'num', text: money(p.n * d.price) }),
              el('td', {}, el('div', { class: 'row' }, [
                el('span', { class: 'pill ' + (all ? 'ok' : 'warn'), text: all ? 'Paid' : p.paid ? p.paid + ' of ' + p.n + ' paid' : 'Not paid' }),
                el('button', { class: 'btn small quiet', type: 'button', text: all ? 'Mark not paid' : 'Mark paid', onclick: function () {
                  call('POST', '/api/admin/squares/paid', { name: p.name, contact: p.contact, paid: !all }, p.name + (all ? ': not paid' : ': paid'));
                } })
              ]))
            ]);
          }) : el('tr', {}, el('td', { colspan: '5', class: 'dim', text: 'Nobody has bought a square yet.' })))
        ])),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Start over' }),
          el('p', { class: 'sub', text: 'Removes every buyer, the numbers and the scores. Price, limit and payouts are kept.' }),
          sure('Clear the whole board', 'danger', function () { call('POST', '/api/admin/squares/reset', { confirm: 'RESET' }, 'Board cleared'); })
        ])
      ]);
      [].forEach.call(app.querySelectorAll('.card h3'), function (h) { h.style.marginTop = '0'; });
      app.querySelector('.card b').style.wordBreak = 'break-all';
      app.querySelector('.tablewrap table').style.minWidth = '560px';
      var cards = app.querySelectorAll('.card'); cards[cards.length - 1].style.marginTop = '14px';
    }).catch(function (e) { if (e.status !== 401) failed('manager', e); });
  }

  // ---------- router
  function route() {
    clearInterval(S.timer);
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    if (parts[0] === 'setup' && parts[1]) return viewSetup(parts[1]);
    if (parts[0] === 'join') return viewJoin();
    if (parts[0] === 'squares') return viewSquares();
    if (!S.me) return viewLogin();
    var isMgr = S.me.role === 'manager';
    if (parts[0] === 'standings') return viewStandings();
    if (parts[0] === 'picks') return viewGrid();
    if (parts[0] === 'account') return viewAccount();
    if (parts[0] === 'activity' && (isMgr || S.me.role === 'support')) return viewManagerLog();
    if (parts[0] === 'manager' && isMgr) {
      if (parts[1] === 'players') return viewManagerPlayers();
      if (parts[1] === 'log') { return viewManagerLog(); }
      if (parts[1] === 'signups') return viewManagerSignups();
      if (parts[1] === 'squares') return viewManagerSquares();
      return viewManagerPicks(parts[1] === 'week' ? Number(parts[2]) || null : null);
    }
    return viewWeek(parts[0] === 'week' ? Number(parts[1]) || null : null);
  }

  window.addEventListener('hashchange', function () { window.scrollTo(0, 0); route(); });
  api('GET', '/api/me').then(function (d) { S.me = d.me; S.league = d.league || S.league; S.nextSeason = d.nextSeason || null; route(); })
    .catch(function (e) { shell('', el('div', { class: 'card' }, [el('p', { text: e.message }), el('button', { class: 'btn', text: 'Try again', onclick: function () { location.reload(); } })])); });
})();
