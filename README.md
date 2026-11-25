# Mekra POS

An offline point of sale for small retail and grocery stores, built with Electron, React and SQLite (`better-sqlite3`). All data stays on the shop computer. No internet connection is needed after installation.

## Features

- **New sale**: barcode scanning with automatic add-to-cart, product search, quantity editing, hold and recall, age-restriction alerts, refunds, and a checkout discount.
- **Khata (customer credit)**: an underpaid sale is added to the selected customer's balance. Payments reduce it.
- **Receipts**: each sale gets a permanent unique number such as `R-20261031-7F3A2C`. Receipts can be previewed, reprinted or deleted from Transactions.
- **Inventory**: products (blank SKU generates a barcode), categories with images, suppliers with payables, and stock-in with unpaid-amount tracking.
- **Dashboard**: today's sales and profit, payables and receivables, a sales trend chart, low-stock watch and hardware status.
- **Tables**: every table has search and pagination (10, 25, 50 or 100 rows per page).
- **Settings**: store profile, logo, theme colors, printer selection, test print and receipt preview.

## Requirements

- Node.js 20 LTS or newer
- Windows: Visual Studio Build Tools with the "Desktop development with C++" workload (needed by `better-sqlite3` if no prebuilt binary is available)
- macOS or Linux: the standard C/C++ build toolchain

## Install and run

```bash
npm install
npm run dev
```

Build the Windows installer:

```bash
npm run dist:win
```

The installer is written to the output folder set in your electron-builder config.

If Electron reports a native module version mismatch after changing Electron versions:

```bash
npx electron-builder install-app-deps
npm run dist:win
```

## First launch

On first launch, enter the one-time setup PIN. The main process checks the PIN, creates the SQLite tables and stores an initialization marker. The PIN is not asked again. This build has no user roles or recurring login.

The PIN is defined as `SETUP_PIN` in `main.cjs`. Change it before giving the app to a client.

## Data location

Everything is stored in Electron's `userData` folder:

| File or folder      | Contents                                |
| ------------------- | --------------------------------------- |
| `pos_data.db`       | SQLite database                         |
| `theme.json`        | Theme colors                            |
| `printer.json`      | Selected printer                        |
| `images/`           | Uploaded category images and store logo |
| `printer-error.log` | Printer and drawer errors               |

Settings > Hardware > "Open log folder" opens this folder. To back up the shop, copy `pos_data.db` and `images/`.

Database changes for new features are applied automatically when the app starts, so existing data is kept. For example, the `receipts.discount` column is added to older databases.

The default theme is:

```json
{ "primary": "#2E7D32", "secondary": "#FFFFFF", "background": "#F5F5F5" }
```

## Hardware

### Receipt printer and cash drawer

Receipts are sent to the printer as raw ESC/POS bytes through the operating system's print spooler. The `escpos` and `escpos-usb` packages are not used.

1. Install the printer's driver and confirm it appears in Windows under Printers.
2. Open Settings > Hardware and choose the printer.
3. Use "Test print" to check the width. Receipts are set for 80 mm paper at 48 characters per line. If text wraps on your printer, set `RECEIPT_WIDTH` to `42` in `main.cjs`.

The cash drawer opens by sending the kick command `1B 70 00 19 FA` to the same printer. If no printer is attached, the sale still completes and a toast shows the printer error.

Settings > Hardware > "Preview receipt" shows how the latest receipt will print, with no printer needed.

### Barcode scanner

HID scanners behave like a keyboard that types the barcode quickly and ends with Enter. The New sale page detects this by typing speed (characters less than about 80 ms apart) and adds the matching item to the cart automatically. It does not matter whether the search box is focused.

Scans are ignored while you are typing in the cash, discount, quantity or customer fields, or while a popup is open. The scanner badge says "Scanner ready" only after the first successful scan, because a keyboard-style device can't be detected earlier. If your scanner is slow and scans aren't recognised, raise `SCAN_GAP_MS` in the `Sale` component.

## Discounts

Enter a discount amount in the checkout panel. It is subtracted from the subtotal, can't exceed it, and is stored on the receipt. Printed receipts show SUBTOTAL and DISCOUNT lines when a discount was given. `total_amount` on a receipt is always the final amount after discount, and today's profit on the dashboard subtracts discounts.

## Balances

- **Supplier**: `current_balance` is what you owe the supplier. Stock-in adds only the unpaid part. A supplier payment reduces it, never below zero.
- **Customer (Khata)**: `current_balance` is what the customer owes you. An underpaid sale adds the shortfall once per sale. Receiving a payment reduces it.
- Payment history is in Reports.

Deleting a receipt restores stock but does not reverse the customer's Khata balance.

## Receipt footer

Every printed receipt ends with the store's closing message followed by the fixed line:

```text
Developed by Hamza
```

## Notes

- Demo data helper: `seedDemoData()` exists in `main.cjs` but is not called on startup. Call it from `initDb` if you want sample products for testing.
- The first-run PIN and the hardcoded receipt footer are intentional in this build.
