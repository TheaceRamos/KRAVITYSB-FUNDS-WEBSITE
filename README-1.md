# KRAVITYSB USDT — TRON Shasta Testnet MVP

Mobile-first testnet prototype with signup, login, user profile, deposit monitoring and queued withdrawals.

## Run
1. Install Node.js 18+.
2. Open this folder in a terminal.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Accounts
- Signup creates a local testnet account.
- Passwords are hashed with Node's built-in `scrypt`; plaintext passwords are never written to the JSON database.
- User information includes name, email, optional TRON wallet address, account status and creation date.
- Sessions use random bearer tokens and are kept in server memory for this MVP.

## Blockchain
- Network: TRON Shasta Testnet
- Legacy/shared test deposit address: `TYyHGjz9jwUM6bqsqaNqwhFqRoTtdQj49x`
- TronGrid endpoint: `https://api.shasta.trongrid.io`
- The MVP now tracks confirmed TRC-20 transfers sent to each user’s registered TRON wallet address.
- Set `DEPOSIT_ADDRESS` or `USDT_CONTRACT` as environment variables if needed.
- Withdrawal requests are deliberately queued only; no private key is stored or used by the server.

## Security
- Never add a seed phrase or private key to this project, frontend code, environment variables, GitHub, or chat.
- This is a testnet prototype, not a production custody system.
- This is wallet tracking, not custodial platform deposits: the server does not own the user wallet and never receives its private key. A true exchange-style deposit system still needs unique platform-controlled deposit addresses plus secure custody/transaction signing infrastructure.
- Before production, use a real session store, HTTPS, rate limiting, CSRF protection, secure cookies, audit logging and a proper database.
