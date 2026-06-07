# ChessV2 Rated

A real account-based ranked chess app built for Render.

## Current features

- Register/login accounts
- MongoDB persistence
- Play Now matchmaking only
- Users cannot pick who they face
- Persistent ELO rating system
- Rated wins/losses/draws
- Saved game records
- 10+0 clock
- Resign
- Offer/accept/decline draw
- Legal move validation using `chess.js`
- Checkmate, stalemate, repetition, insufficient material, 50-move/draw detection through chess rules
- Leaderboard
- Recent game history
- Mobile-friendly board

## Required Render env vars

```txt
MONGO_DB=mongodb+srv://...
SESSION_SECRET=make-a-long-random-secret
```

`MONGO_DB` is required for accounts, sessions, games, and ratings.

## Render deploy

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

## Local development

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Notes

This app is intentionally matchmaking-only. There are no invite codes and no picking opponents, so it works like a simple ranked queue.
