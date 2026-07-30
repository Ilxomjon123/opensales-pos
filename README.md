# OpenSales POS

Offline-first desktop point-of-sale application for retail shops in Uzbekistan. Part of the [OpenSales](https://opensales.uz) platform — digital infrastructure for wholesale trade between dealers and shops (Telegram bot, mobile app, dealer web panel, and this POS).

Built with **Tauri 2 (Rust)** and **Vue 3 + TypeScript**, backed by a local **SQLite** database. Designed for regions with unreliable connectivity: every core operation works with no internet at all.

## Features

- **Sales terminal** — fast product search (Cyrillic/Latin transliteration aware), cart, receipt printing
- **Fully offline** — sales, inventory, customers, and reports run on local SQLite; no network required
- **Shifts** — open/close cashier shifts with cash reconciliation
- **Products & categories** — local catalog with stock tracking and image compression (WebP)
- **Customers & debt** — per-customer balances and debt history
- **Expenses** — expense tracking per shift
- **Reports** — daily and periodic sales reports
- **Thermal printer support** — silent direct printing, including native Bluetooth Low Energy printers
- **Offline licensing** — Ed25519 signature-based activation, verified locally without a server
- **Auto-update** — background update checks via GitHub Releases
- **Automatic backups** — daily local backups (SQLite `VACUUM INTO`), with optional cloud sync

## Tech stack

| Layer | Technology |
|---|---|
| Shell / native | Tauri 2, Rust |
| UI | Vue 3, TypeScript, Vite, Tailwind CSS v4 |
| Storage | SQLite (local, migration-versioned) |
| Licensing | Ed25519 offline signature verification |
| Distribution | macOS / Windows builds via CI, GitHub Releases auto-update |

## Development

```bash
npm install
npm run tauri dev
```

Production build:

```bash
npm run build
npx tauri build
```

## About OpenSales

OpenSales digitalizes the full wholesale trade cycle in Uzbekistan: shopkeepers order from dealers via a Telegram bot or mobile app, dealers manage orders, inventory, debt, and delivery from a web panel, and in-store retail sales run on this offline POS. The platform has been in production since April 2026.

Website: [opensales.uz](https://opensales.uz)
