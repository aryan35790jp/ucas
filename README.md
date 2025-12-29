# apptest_2 (UCAS automation only)

This folder is a clean, standalone copy of the UCAS Playwright automation.

## Setup

```powershell
Set-Location -LiteralPath "C:\apptest\apptest_2"
npm install
npx playwright install
```

## Run

- First-time auth (manual login, saves session):

```powershell
npm run ucas:auth
```

- Open UCAS using saved session:

```powershell
npm run ucas:open
```

- Run the full UCAS runner:

```powershell
npm run ucas
```

- Run the UCAS runner with options (recommended when passing flags like `--run-all`, `--section`):

```powershell
node .\automation\ucas\ucas.cjs --run-all --section "Personal details"
```
