# Tbone's 12th Survivor: league website

A website for the league: every player logs in and makes one pick a week, picks lock
5 minutes before kickoff, spreads and final scores come in on their own, and the
standings keep themselves.

## What it does

- **Logins.** Each player has their own name and password. League managers can also
  enter or fix anyone's pick.
- **Weekly matchups with point spreads.** Schedule, scores and spreads come from ESPN's
  NFL scoreboard feed (the spread is the sportsbook line ESPN publishes; the page names
  the book). Spreads update until kickoff, then freeze.
- **The lock.** A game closes 5 minutes before its kickoff. The server enforces it, so
  it cannot be bypassed from a phone. Once your picked game locks, your week is locked.
- **League rules, from the spreadsheet.** One team per week. A team can be used once a
  season. A win adds the margin of victory, a loss subtracts the margin of defeat.
  Nobody is eliminated. Standings are fewest losses, then most points.
- **Hidden picks.** Other players cannot see your pick until its game locks.
- **Players only pick a team.** Points are never typed in by players; they come from the
  final score.
- **Sign-ups for next season.** A public sign-up page (linked from the log-in page) lets
  new people leave their name and contact. League managers see the list under Manager,
  Sign-ups, and can add people to it themselves. Signing up does not add anyone to the current season.
- **Super Bowl squares.** A public 10 by 10 board anyone with the link can buy on (name and
  contact, no login). The manager sets the price, payouts and limit, draws the numbers,
  and tracks who has paid under Manager, Squares. Quarter scores fill in from the schedule
  on game day or can be entered by hand. The site records what is owed; it does not take
  payments.
- **Activity log.** Everything anyone does is recorded with the date and time to the second:
  log-ins, picks made, changed or removed, sign-ups, squares, and every manager change. It
  can be filtered by person and by type. A team is shown in the log only after its game
  locks.
- **Roles.** Tyler H. starts as the league manager. Ricky A. starts as "support": he can read
  the activity log but cannot change picks, players or anything else. A league manager can
  change anyone's role under Manager, Players.
- **Missed picks.** The manager decides: enter a late pick, or score the week by hand.
- **Starting data.** All 52 players and their Weeks 1 to 8 picks are loaded from the
  spreadsheet the first time the site starts.

## Put it online (about 15 minutes, free)

You need three free accounts: Neon (stores the data), GitHub (holds the files) and
Render (runs the site).

### 1. Create the database at Neon

1. Sign up at neon.com and create a project (any name, for example `survivor`).
2. On the project page, press **Connect** and copy the connection string. It starts
   with `postgresql://`. Keep it for step 3.

### 2. Put these files on GitHub

1. Sign up at github.com and create a new **private** repository (for example
   `survivor-league`).
2. On the empty repository page choose **uploading an existing file**, drag in
   everything inside this folder, and press **Commit changes**.

### 3. Run it on Render

1. Sign up at render.com with your GitHub account.
2. **New**, then **Web Service**, then pick the repository from step 2.
3. Settings: Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
4. Under **Environment Variables** add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the connection string from Neon |
   | `MANAGER_PASSWORD` | a password you choose for the league manager login |

5. Press **Deploy Web Service**. After a few minutes Render shows the site address,
   something like `https://survivor-league.onrender.com`.

### 4. First login

1. Open the site address. Log in with the name `manager` and your `MANAGER_PASSWORD`.
2. Open **Manager**, then **Players**. Press **Copy all names and links** and send each
   player their own link. Opening it lets them choose a password. After that they log in
   with their name as it appears in the standings (for example `AJ S.`).
3. The `manager` login is only a set-up account. Tyler H. is already a league manager under
   his own name, so once he has used his setup link he can remove the set-up account under
   Manager, Players.

### 5. Schedule the 5 AM wake-up (free plan only)

The program runs its daily update at 5:00 AM Eastern: it looks up the schedule, finds the
final scores, and adds each win or loss margin to the standings. Render's free plan puts
the site to sleep when nobody is using it, so something has to wake it at 5 AM:

1. Sign up at cron-job.org (free) and create a cronjob.
2. Address: your site address followed by `/api/daily-update`, for example
   `https://survivor-league.onrender.com/api/daily-update`.
3. Schedule: every day at 5:01 and 5:05, with the time zone set to America/New_York.
   The first call wakes the site (it may show as timed out; that is fine), the second
   confirms it.

Skip this step on Render's paid always-on instance: the 5 AM update then runs by itself.
If a 5 AM run is ever missed, the update runs as soon as the site next wakes up.

## Good to know

- **The free Render plan sleeps** after 15 minutes without visitors, so the first person
  to open the site waits about a minute. Render's paid instance removes the wait.
- **Scores post two ways.** The daily 5 AM Eastern update, and whenever someone opens the
  site after a game ends. Manager, Activity shows when the daily update last ran and has a
  button to run it by hand.
- **Forgot a password?** Manager, Players, **Reset password** gives a new link to send.
- **Who can see what.** Nobody sees another player's pick before its game locks, in the
  standings or in the activity log. One limit to know: whoever hosts the site controls the
  database behind it, and the app cannot hide the stored picks from that person.
- **Paid** checkboxes are only visible to league managers.

## Optional settings (environment variables)

| Name | Default | What it does |
|---|---|---|
| `LEAGUE_NAME` | Tbone's 12th Survivor | Name shown at the top |
| `LOCK_MINUTES` | 5 | Minutes before kickoff that a game locks |
| `SEASON` | 2026 | NFL season year |
| `DAILY_HOUR` | 5 | Hour (Eastern) of the daily update |

## Try it on your own computer first

With Node.js 22.5 or newer installed, run `npm install` and then `npm start` in this
folder, and open http://localhost:3000. Without `DATABASE_URL` it keeps its data in a
local file (`data/league.db`). The manager password is printed in the terminal.

## Next season

Create a new Neon project, replace `seed/league.json` with the new player list (same
format, empty `picks`), set `SEASON`, and point `DATABASE_URL` at the new database.
