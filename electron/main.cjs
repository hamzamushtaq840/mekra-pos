const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);
const { pathToFileURL } = require("url");
const { fileURLToPath } = require("url");
const Database = require("better-sqlite3");

const userDir = app.getPath("userData");
const db = new Database(path.join(userDir, "pos_data.db"));
const themePath = path.join(userDir, "theme.json");
const SETUP_PIN = "827123";
const DEFAULT_THEME = {
  primary: "#2E7D32",
  secondary: "#FFFFFF",
  background: "#F5F5F5",
};
const logPath = path.join(userDir, "printer-error.log");

function logError(label, error) {
  const line = `[${new Date().toISOString()}] ${label}: ${error?.stack || error}\n`;
  console.error(line);
  try {
    fs.appendFileSync(logPath, line);
  } catch {}
}

// ---------- Printing via the OS print spooler (raw ESC/POS) ----------
const printerSettingsPath = path.join(userDir, "printer.json");
const psScriptPath = path.join(userDir, "raw-print.ps1");

const RAW_PRINT_PS = `param([string]$Printer, [string]$DataFile)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ") for '" + printer + "'");
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "POS Receipt";
    di.pDataType = "RAW";
    try {
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(h, p, bytes.Length, out written)) throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes($DataFile)
[RawPrint]::Send($Printer, $bytes)
`;

function getSavedPrinter() {
  try {
    return (
      JSON.parse(fs.readFileSync(printerSettingsPath, "utf8")).name || null
    );
  } catch {
    return null;
  }
}

async function listPrinters() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return [];
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, isDefault: !!p.isDefault }));
}

async function resolvePrinterName() {
  const list = await listPrinters();
  const saved = getSavedPrinter();
  if (saved && list.some((p) => p.name === saved)) return saved;
  const guess = list.find((p) =>
    /pos|receipt|thermal|xprinter|ocpp|rongta|epson|tm-/i.test(p.name),
  );
  return guess?.name || list.find((p) => p.isDefault)?.name || null;
}

async function sendRaw(buffer) {
  const name = await resolvePrinterName();
  if (!name)
    throw new Error("No printer found. Choose one in Settings > Hardware.");
  const tmp = path.join(os.tmpdir(), `pos-job-${Date.now()}.bin`);
  fs.writeFileSync(tmp, buffer);
  try {
    if (process.platform === "win32") {
      fs.writeFileSync(psScriptPath, RAW_PRINT_PS);
      await execFileP(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          psScriptPath,
          "-Printer",
          name,
          "-DataFile",
          tmp,
        ],
        { windowsHide: true, timeout: 20000 },
      );
    } else {
      // macOS / Linux (development): CUPS raw queue
      await execFileP("lp", ["-d", name, "-o", "raw", tmp], { timeout: 20000 });
    }
  } catch (error) {
    throw new Error(
      String(error.stderr || error.message || error)
        .trim()
        .split("\n")[0],
    );
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ---------- Receipt builder (ESC/POS bytes + HTML preview) ----------
const ESC = 0x1b;
const GS = 0x1d;
const RECEIPT_WIDTH = 48; // characters per line; use 42 if text wraps on your printer
const LOGO_MAX_WIDTH = 288; // dots (a full 80mm line is about 576 dots)
const LOGO_MAX_HEIGHT = 120;
const ALIGN = { left: 0, center: 1, right: 2 };

const toAscii = (text) => String(text ?? "").replace(/[^\x20-\x7E]/g, "?");
const fmt = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function wrapText(text, width) {
  const words = toAscii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (let word of words) {
    while (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!word) continue;
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += " " + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function createReceipt(width = RECEIPT_WIDTH) {
  const ops = [];
  const state = { align: "left", bold: false, w: 1, h: 1 };
  const cols = () => Math.floor(width / state.w);
  const api = {
    width,
    set(partial) {
      Object.assign(state, partial);
      return api;
    },
    text(s = "") {
      for (const line of String(s).split("\n"))
        ops.push({ t: "text", text: toAscii(line), ...state });
      return api;
    },
    wrap(s) {
      wrapText(s, cols()).forEach((line) => api.text(line));
      return api;
    },
    rule(ch = "-") {
      return api.text(ch.repeat(cols()));
    },
    row(left, right) {
      const total = cols();
      right = toAscii(right);
      left = toAscii(left).slice(0, Math.max(0, total - right.length - 1));
      return api.text(
        left + " ".repeat(total - left.length - right.length) + right,
      );
    },
    feed(dots) {
      ops.push({ t: "feed", dots });
      return api;
    },
    image(img) {
      ops.push({ t: "image", img, align: state.align });
      return api;
    },
    toBytes() {
      const out = [Buffer.from([ESC, 0x40])]; // initialize
      for (const op of ops) {
        if (op.t === "text") {
          out.push(
            Buffer.from([
              ESC,
              0x61,
              ALIGN[op.align],
              ESC,
              0x45,
              op.bold ? 1 : 0,
              GS,
              0x21,
              ((op.w - 1) << 4) | (op.h - 1),
            ]),
          );
          out.push(Buffer.from(op.text + "\n", "ascii"));
        } else if (op.t === "feed") {
          out.push(Buffer.from([ESC, 0x4a, op.dots]));
        } else if (op.t === "image") {
          out.push(Buffer.from([ESC, 0x61, ALIGN[op.align]]), op.img.escpos);
        }
      }
      out.push(Buffer.from([ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0]));
      out.push(Buffer.from("\n\n\n\n", "ascii"));
      out.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // feed and cut
      return Buffer.concat(out);
    },
    toHtml() {
      const esc = (s) =>
        String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const body = ops
        .map((op) => {
          if (op.t === "feed")
            return `<div style="height:${(op.dots / 24) * 1.25}em"></div>`;
          if (op.t === "image")
            return `<div style="text-align:${op.align}"><img src="${op.img.dataUrl}" style="width:${(op.img.width / (width * 12)) * 100}%;image-rendering:pixelated"></div>`;
          const extraY = op.h / op.w;
          return `<div class="ln" style="text-align:${op.align};font-weight:${op.bold ? 700 : 400};font-size:${op.w}em;height:${extraY * 1.25}em"><span style="display:inline-block;transform-origin:50% 0;transform:scaleY(${extraY})">${esc(op.text) || "&nbsp;"}</span></div>`;
        })
        .join("");
      return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt preview</title><style>
        body{background:#d9d9d9;margin:0;padding:24px 0}
        .paper{width:${width}ch;margin:0 auto;padding:20px 16px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.25);
          font-family:"SF Mono",Menlo,Consolas,monospace;font-size:14px;line-height:1.25;color:#000}
        .ln{white-space:pre;overflow:visible}
      </style></head><body><div class="paper">${body}</div></body></html>`;
    },
  };
  return api;
}

// Converts the store logo into a 1-bit ESC/POS raster image (GS v 0).
function loadLogo(logoPath) {
  try {
    const file = resolveImagePath(logoPath);
    if (!file || !fs.existsSync(file)) return null;
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const scale = Math.min(
      LOGO_MAX_WIDTH / size.width,
      LOGO_MAX_HEIGHT / size.height,
      1,
    );
    img = img.resize({
      width: Math.max(8, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "best",
    });
    const { width, height } = img.getSize();
    const bgra = img.toBitmap();
    const rowBytes = Math.ceil(width / 8);
    const data = Buffer.alloc(rowBytes * height);
    const preview = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // transparent pixels count as white paper
        const lum =
          0.114 * bgra[i] +
          0.587 * bgra[i + 1] +
          0.299 * bgra[i + 2] +
          (255 - bgra[i + 3]);
        if (lum < 128) {
          data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
          preview[i] = preview[i + 1] = preview[i + 2] = 0;
        }
      }
    }
    const header = Buffer.from([
      GS,
      0x76,
      0x30,
      0x00,
      rowBytes & 255,
      rowBytes >> 8,
      height & 255,
      height >> 8,
    ]);
    const dataUrl = nativeImage
      .createFromBitmap(preview, { width, height })
      .toDataURL();
    return { width, height, escpos: Buffer.concat([header, data]), dataUrl };
  } catch (error) {
    logError("logo failed", error);
    return null;
  }
}

// SQLite stores CURRENT_TIMESTAMP in UTC, so convert it to the PC's local time.
function receiptTime(dbValue) {
  const d = new Date(String(dbValue || "").replace(" ", "T") + "Z");
  if (isNaN(d)) return { date: String(dbValue || ""), time: "" };
  return {
    date: d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }),
    time: d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }),
  };
}

const SAMPLE_ITEMS = [
  { item_name: "Premium Basmati Rice 5kg", qty_sold: 1, price_sold: 1050 },
  { item_name: "Cooking Oil 1L", qty_sold: 2, price_sold: 510 },
  { item_name: "Cola Can 330ml", qty_sold: 3, price_sold: 110 },
];

// With a receiptId it builds that receipt. Without one it uses the latest
// receipt, or a sample if there are none (used by the preview).
function buildReceipt(receiptId) {
  let receipt = receiptId
    ? one("SELECT * FROM receipts WHERE receipt_id=?", [receiptId])
    : one("SELECT * FROM receipts ORDER BY receipt_id DESC LIMIT 1");
  if (receiptId && !receipt) throw new Error("Receipt not found.");
  let items;
  if (receipt) {
    items = rows("SELECT * FROM receipt_items WHERE receipt_id=?", [
      receipt.receipt_id,
    ]);
  } else {
    items = SAMPLE_ITEMS;
    receipt = {
      receipt_code: "R-SAMPLE",
      date_time: new Date().toISOString().slice(0, 19).replace("T", " "),
      total_amount: 2400,
      discount: 0,
      cash_tendered: 2500,
      customer_id: null,
    };
  }
  const profile = one("SELECT * FROM store_profile WHERE id=1") || {};
  const customer = receipt.customer_id
    ? one("SELECT name FROM customers WHERE customer_id=?", [
        receipt.customer_id,
      ])
    : null;
  const { date, time } = receiptTime(receipt.date_time);
  // total_amount is the final amount after discount.
  const total = Number(receipt.total_amount || 0);
  const discount = Number(receipt.discount || 0);
  const cash = Number(receipt.cash_tendered || 0);

  const r = createReceipt();

  // ----- header -----
  r.set({ align: "center" });
  const logo = loadLogo(profile.logo_path);
  if (logo) r.image(logo).feed(8);
  const name = (profile.company_name || "My Store").toUpperCase();
  const big = name.length <= r.width / 2;
  r.set({ bold: true, w: big ? 2 : 1, h: 2 }).wrap(name);
  r.set({ bold: false, w: 1, h: 1 });
  if (profile.business_trade) r.wrap(profile.business_trade);
  if (profile.address) r.wrap(profile.address);
  if (profile.phone_no) r.text(profile.phone_no);

  // ----- receipt info -----
  r.set({ align: "left" }).feed(6).rule("-");
  r.row("Receipt:", receipt.receipt_code || `#${receipt.receipt_id}`);
  r.row("Date:", date);
  if (time) r.row("Time:", time);
  r.row("Customer:", customer?.name || "Walk-in");
  r.rule("-");

  // ----- items -----
  r.set({ bold: true }).row("ITEM", "AMOUNT");
  r.set({ bold: false }).rule("-");
  for (const item of items) {
    r.wrap(item.item_name);
    r.row(
      `  ${item.qty_sold} x ${fmt(item.price_sold)}`,
      fmt(item.price_sold * item.qty_sold),
    );
    r.feed(8);
  }
  r.rule("-");

  // ----- totals -----
  const totalQty = items.reduce((sum, i) => sum + Number(i.qty_sold || 0), 0);
  r.row(`Items: ${items.length}`, `Qty: ${totalQty}`).feed(6);
  if (discount > 0) {
    r.row("SUBTOTAL", fmt(total + discount));
    r.row("DISCOUNT", `-${fmt(discount)}`);
  }
  r.set({ bold: true, h: 2 }).row("TOTAL", fmt(total));
  r.set({ bold: false, h: 1 });
  if (cash >= total) {
    r.row("CASH", fmt(cash));
    r.row("CHANGE", fmt(cash - total));
  } else {
    r.row("PAID", fmt(cash));
    r.set({ bold: true }).row("KHATA DUE", fmt(total - cash));
    r.set({ bold: false });
  }
  r.rule("-");

  // ----- footer -----
  r.feed(8).set({ align: "center" });
  r.wrap(profile.message_at_end || "Thank you for shopping");
  r.text("Developed by Hamza");
  return r;
}

function testReceipt() {
  const r = createReceipt();
  r.set({ align: "center", bold: true, h: 2 }).text("TEST PRINT");
  r.set({ bold: false, h: 1 }).rule("-");
  r.text("Mekra POS printer works.");
  r.set({ align: "left" }).feed(6);
  r.text("123456789012345678901234567890123456789012345678"); // width ruler
  r.row("Left", "Right");
  r.rule("-");
  return r;
}
const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

ipcMain.handle("open-log-folder", async () => {
  // If the log exists, open the folder with the file selected.
  if (fs.existsSync(logPath)) {
    shell.showItemInFolder(logPath);
    return { ok: true };
  }
  // Otherwise just open the data folder.
  const error = await shell.openPath(userDir);
  return error ? { ok: false, error } : { ok: true };
});

function initDb(pin) {
  if (pin !== SETUP_PIN) throw new Error("Incorrect setup PIN.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_profile (id INTEGER PRIMARY KEY CHECK(id=1), company_name TEXT, business_trade TEXT, address TEXT, phone_no TEXT, mail TEXT, logo_path TEXT, message_at_end TEXT);
    CREATE TABLE IF NOT EXISTS categories (category_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, image_path TEXT, sorting_level INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS suppliers (supplier_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone_no TEXT, email TEXT, address TEXT, credit_limit REAL DEFAULT 0, current_balance REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS supplier_payments (payment_id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT DEFAULT CURRENT_TIMESTAMP, supplier_id INTEGER, amount_paid REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS customers (customer_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, current_balance REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS customer_payments (payment_id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT DEFAULT CURRENT_TIMESTAMP, customer_id INTEGER, amount_paid REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS products (sku TEXT PRIMARY KEY, category_id INTEGER, supplier_id INTEGER, item_name TEXT NOT NULL, description TEXT, purchase_price REAL DEFAULT 0, selling_price REAL DEFAULT 0, size TEXT, weight TEXT, age_restriction INTEGER DEFAULT 0, start_date TEXT, end_date TEXT, expiry_date TEXT, quantity INTEGER DEFAULT 0, low_stock_alert INTEGER DEFAULT 5);
    CREATE TABLE IF NOT EXISTS held_carts (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP, cart_data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (receipt_id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_code TEXT, date_time TEXT DEFAULT CURRENT_TIMESTAMP, total_amount REAL NOT NULL, discount REAL DEFAULT 0, customer_id INTEGER, cash_tendered REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS receipt_items (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id INTEGER, sku TEXT, item_name TEXT, qty_sold INTEGER, price_sold REAL);
    CREATE TABLE IF NOT EXISTS refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, date_time TEXT DEFAULT CURRENT_TIMESTAMP, sku TEXT, qty INTEGER, amount REAL);
    INSERT OR IGNORE INTO store_profile (id, company_name, business_trade, message_at_end) VALUES (1, 'My Store', 'Retail Store', 'Thank you for shopping');
  `);
  const receiptColumns = db.prepare("PRAGMA table_info(receipts)").all();
  if (!receiptColumns.some((column) => column.name === "receipt_code")) {
    db.exec("ALTER TABLE receipts ADD COLUMN receipt_code TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_receipt_code ON receipts(receipt_code)",
  );
  const existingReceipts = rows(
    "SELECT receipt_id FROM receipts WHERE receipt_code IS NULL",
  );
  for (const receipt of existingReceipts) {
    run("UPDATE receipts SET receipt_code=? WHERE receipt_id=?", [
      `R-${String(receipt.receipt_id).padStart(8, "0")}`,
      receipt.receipt_id,
    ]);
  }
  migrateDatabase();
  fs.writeFileSync(themePath, JSON.stringify(DEFAULT_THEME, null, 2));
  db.prepare(
    "INSERT OR REPLACE INTO app_meta(key,value) VALUES('admin_pin',?)",
  ).run(pin);
}

// Runs on every app start so databases created before a feature existed get
// the new columns without losing data.
function migrateDatabase() {
  const hasReceipts = one(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='receipts'",
  );
  if (!hasReceipts) return;
  const columns = rows("PRAGMA table_info(receipts)");
  if (!columns.some((column) => column.name === "discount")) {
    db.exec("ALTER TABLE receipts ADD COLUMN discount REAL DEFAULT 0");
  }
}

function seedDemoData() {
  const count = one("SELECT COUNT(*) AS count FROM products");
  if (count && count.count > 0) return;
  const seed = db.transaction(() => {
    const categories = {};
    for (const [name, sorting] of [
      ["Groceries", 1],
      ["Beverages", 2],
      ["Snacks", 3],
      ["Household", 4],
      ["Personal care", 5],
    ])
      categories[name] = run(
        "INSERT INTO categories(name,sorting_level) VALUES(?,?)",
        [name, sorting],
      ).lastInsertRowid;
    const suppliers = {};
    for (const [name, phone, email, address, credit, balance] of [
      [
        "FreshMart Wholesale",
        "+92 300 1234567",
        "orders@freshmart.local",
        "Main Market",
        50000,
        18500,
      ],
      [
        "Daily Needs Supply",
        "+92 301 7654321",
        "sales@dailyneeds.local",
        "Wholesale Avenue",
        30000,
        7200,
      ],
      [
        "Metro Beverages",
        "+92 302 5550911",
        "hello@metrobev.local",
        "Industrial Estate",
        80000,
        0,
      ],
      [
        "CleanHome Distributors",
        "+92 303 2227844",
        "orders@cleanhome.local",
        "North Warehouse",
        45000,
        12400,
      ],
    ])
      suppliers[name] = run(
        "INSERT INTO suppliers(name,phone_no,email,address,credit_limit,current_balance) VALUES(?,?,?,?,?,?)",
        [name, phone, email, address, credit, balance],
      ).lastInsertRowid;
    const customers = {};
    for (const [name, phone, balance] of [
      ["Walk-in Regular", "+92 333 5551212", 0],
      ["Nadia Khan", "+92 321 1112233", 2400],
      ["Bilal Traders", "+92 311 8781200", 6800],
      ["Ayesha Malik", "+92 333 9012234", 0],
      ["Office Pantry", "+92 300 4419821", 1250],
    ])
      customers[name] = run(
        "INSERT INTO customers(name,phone,current_balance) VALUES(?,?,?)",
        [name, phone, balance],
      ).lastInsertRowid;
    const products = [
      [
        "890100000001",
        "Groceries",
        "FreshMart Wholesale",
        "Premium Basmati Rice 5kg",
        "Long grain family pack",
        850,
        1050,
        "5kg",
        "5",
        24,
        5,
      ],
      [
        "890100000002",
        "Groceries",
        "FreshMart Wholesale",
        "Cooking Oil 1L",
        "Canola cooking oil",
        420,
        510,
        "1L",
        "1",
        36,
        8,
      ],
      [
        "890100000003",
        "Beverages",
        "Metro Beverages",
        "Black Tea 450g",
        "Strong breakfast tea",
        650,
        780,
        "450g",
        "0.45",
        18,
        5,
      ],
      [
        "890100000004",
        "Groceries",
        "FreshMart Wholesale",
        "Fine Sugar 1kg",
        "Refined white sugar",
        145,
        180,
        "1kg",
        "1",
        50,
        10,
      ],
      [
        "890100000005",
        "Groceries",
        "FreshMart Wholesale",
        "Milk Powder 500g",
        "Full cream milk powder",
        720,
        880,
        "500g",
        "0.5",
        12,
        4,
      ],
      [
        "890100000006",
        "Beverages",
        "Metro Beverages",
        "Mineral Water 1.5L",
        "Purified drinking water",
        65,
        95,
        "1.5L",
        "1.5",
        72,
        12,
      ],
      [
        "890100000007",
        "Beverages",
        "Metro Beverages",
        "Cola Can 330ml",
        "Chilled soft drink",
        75,
        110,
        "330ml",
        "0.33",
        40,
        8,
      ],
      [
        "890100000008",
        "Snacks",
        "Daily Needs Supply",
        "Potato Chips 60g",
        "Salted potato chips",
        55,
        85,
        "60g",
        "0.06",
        28,
        8,
      ],
      [
        "890100000009",
        "Snacks",
        "Daily Needs Supply",
        "Chocolate Bar 45g",
        "Milk chocolate",
        80,
        120,
        "45g",
        "0.045",
        22,
        6,
      ],
      [
        "890100000010",
        "Snacks",
        "Daily Needs Supply",
        "Cream Biscuits 120g",
        "Vanilla cream biscuits",
        65,
        100,
        "120g",
        "0.12",
        31,
        8,
      ],
      [
        "890100000011",
        "Household",
        "CleanHome Distributors",
        "Laundry Detergent 1kg",
        "Daily wash detergent",
        310,
        390,
        "1kg",
        "1",
        9,
        4,
      ],
      [
        "890100000012",
        "Household",
        "CleanHome Distributors",
        "Dishwashing Liquid 500ml",
        "Lemon dish wash",
        185,
        250,
        "500ml",
        "0.5",
        16,
        5,
      ],
      [
        "890100000013",
        "Household",
        "CleanHome Distributors",
        "Kitchen Tissue Roll",
        "Two-ply tissue",
        120,
        170,
        "1 roll",
        "0.2",
        20,
        5,
      ],
      [
        "890100000014",
        "Personal care",
        "CleanHome Distributors",
        "Hand Wash 250ml",
        "Moisturizing hand wash",
        210,
        290,
        "250ml",
        "0.25",
        14,
        4,
      ],
      [
        "890100000015",
        "Personal care",
        "CleanHome Distributors",
        "Shampoo 400ml",
        "Daily care shampoo",
        390,
        520,
        "400ml",
        "0.4",
        8,
        3,
      ],
      [
        "890100000016",
        "Groceries",
        "FreshMart Wholesale",
        "Red Lentils 1kg",
        "Premium masoor daal",
        280,
        360,
        "1kg",
        "1",
        4,
        6,
      ],
      [
        "890100000017",
        "Groceries",
        "FreshMart Wholesale",
        "Wheat Flour 10kg",
        "Stoneground flour",
        960,
        1180,
        "10kg",
        "10",
        18,
        4,
      ],
      [
        "890100000018",
        "Beverages",
        "Metro Beverages",
        "Mango Juice 1L",
        "Real fruit juice",
        190,
        260,
        "1L",
        "1",
        3,
        5,
      ],
    ];
    for (const [
      sku,
      category,
      supplier,
      name,
      description,
      purchase,
      sale,
      size,
      weight,
      quantity,
      lowStock,
    ] of products)
      run(
        "INSERT INTO products(sku,category_id,supplier_id,item_name,description,purchase_price,selling_price,size,weight,quantity,low_stock_alert) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
          sku,
          categories[category],
          suppliers[supplier],
          name,
          description,
          purchase,
          sale,
          size,
          weight,
          quantity,
          lowStock,
        ],
      );
    const receipts = [
      ["2026-10-25 09:14:00", 1560, null, 1600],
      ["2026-10-26 11:38:00", 2440, customers["Nadia Khan"], 2000],
      ["2026-10-27 13:06:00", 875, null, 900],
      ["2026-10-28 15:22:00", 3210, customers["Bilal Traders"], 2500],
      ["2026-10-29 10:11:00", 1980, null, 2000],
      ["2026-10-30 17:45:00", 4260, customers["Office Pantry"], 4000],
    ];
    for (const [date, total, customerId, cash] of receipts) {
      const receipt = run(
        "INSERT INTO receipts(receipt_code,date_time,total_amount,customer_id,cash_tendered) VALUES(?,?,?,?,?)",
        [uniqueReceiptCode(), date, total, customerId, cash],
      );
      const product = products[Math.floor(Math.random() * products.length)];
      run(
        "INSERT INTO receipt_items(receipt_id,sku,item_name,qty_sold,price_sold) VALUES(?,?,?,?,?)",
        [receipt.lastInsertRowid, product[0], product[3], 1, product[6]],
      );
    }
    run("INSERT INTO held_carts(cart_data) VALUES(?)", [
      JSON.stringify([
        {
          sku: "890100000008",
          item_name: "Potato Chips 60g",
          selling_price: 85,
          qty: 2,
        },
      ]),
    ]);
  });
  seed();
}
function ensureRuntime() {
  if (!fs.existsSync(themePath))
    fs.writeFileSync(themePath, JSON.stringify(DEFAULT_THEME, null, 2));
}
function ensureDatabaseBootstrap() {
  db.exec(
    "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
}
function rows(sql, params = []) {
  return db.prepare(sql).all(params);
}
function one(sql, params = []) {
  return db.prepare(sql).get(params);
}
function run(sql, params = []) {
  return db.prepare(sql).run(params);
}
function uniqueSku() {
  let sku;
  do
    sku =
      String(Date.now()).slice(-8) +
      Math.floor(Math.random() * 100000)
        .toString()
        .padStart(5, "0");
  while (one("SELECT sku FROM products WHERE sku=?", [sku]));
  return sku;
}
function uniqueReceiptCode() {
  let code;
  do {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    code = `R-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  } while (one("SELECT receipt_id FROM receipts WHERE receipt_code=?", [code]));
  return code;
}
function resolveImagePath(value) {
  if (!value) return "";
  if (String(value).startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return "";
    }
  }
  return String(value);
}
function setupIpc() {
  ipcMain.handle("app-status", () => ({
    initialized:
      one("SELECT value FROM app_meta WHERE key='admin_pin'")?.value ===
      SETUP_PIN,
  }));
  ipcMain.handle("activate", (_, { pin }) => {
    initDb(pin);
    return { ok: true };
  });
  ipcMain.handle("theme", () => {
    ensureRuntime();
    return JSON.parse(fs.readFileSync(themePath, "utf8"));
  });
  ipcMain.handle("theme-save", (_, theme) => {
    const saved = { ...DEFAULT_THEME, ...theme };
    fs.writeFileSync(themePath, JSON.stringify(saved, null, 2));
    return saved;
  });
  ipcMain.handle("upload-image", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const source = result.filePaths[0];
    const stat = fs.statSync(source);
    if (stat.size > 10 * 1024 * 1024)
      throw new Error("Image must be 10 MB or smaller.");
    const imageDir = path.join(userDir, "images");
    fs.mkdirSync(imageDir, { recursive: true });
    const extension = path.extname(source).toLowerCase() || ".png";
    const destination = path.join(
      imageDir,
      `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`,
    );
    fs.copyFileSync(source, destination);
    if (!fs.existsSync(destination))
      throw new Error("The selected image could not be saved.");
    const mimeTypes = {
      ".gif": "image/gif",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    const mime = mimeTypes[extension] || "application/octet-stream";
    const preview = `data:${mime};base64,${fs.readFileSync(destination).toString("base64")}`;
    return { path: destination, url: pathToFileURL(destination).href, preview };
  });
  ipcMain.handle("image-data", (_, imagePath) => {
    const resolvedPath = resolveImagePath(imagePath);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return { ok: false };
    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      ".gif": "image/gif",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    const mime = mimeTypes[extension] || "application/octet-stream";
    return {
      ok: true,
      url: `data:${mime};base64,${fs.readFileSync(resolvedPath).toString("base64")}`,
    };
  });
  ipcMain.handle("query", (_, { sql, params }) => rows(sql, params));
  ipcMain.handle("one", (_, { sql, params }) => one(sql, params));
  ipcMain.handle("run", (_, { sql, params }) => run(sql, params));
  ipcMain.handle("save-product", (_, p) => {
    const sku = p.sku || uniqueSku();
    run(
      `INSERT INTO products(sku,category_id,supplier_id,item_name,description,purchase_price,selling_price,size,weight,age_restriction,start_date,end_date,expiry_date,quantity,low_stock_alert) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET category_id=excluded.category_id,supplier_id=excluded.supplier_id,item_name=excluded.item_name,description=excluded.description,purchase_price=excluded.purchase_price,selling_price=excluded.selling_price,size=excluded.size,weight=excluded.weight,age_restriction=excluded.age_restriction,start_date=excluded.start_date,end_date=excluded.end_date,expiry_date=excluded.expiry_date,quantity=excluded.quantity,low_stock_alert=excluded.low_stock_alert`,
      [
        sku,
        p.category_id,
        p.supplier_id,
        p.item_name,
        p.description,
        p.purchase_price,
        p.selling_price,
        p.size,
        p.weight,
        p.age_restriction,
        p.start_date,
        p.end_date,
        p.expiry_date,
        p.quantity,
        p.low_stock_alert,
      ],
    );
    return one("SELECT * FROM products WHERE sku=?", [sku]);
  });
  ipcMain.handle(
    "checkout",
    (_, { cart, customerId, cashTendered, discount }) => {
      const subtotal = cart.reduce((s, i) => s + i.selling_price * i.qty, 0);
      // Discount is clamped so the total can never go negative.
      const discountAmount = Math.min(
        subtotal,
        Math.max(0, Number(discount) || 0),
      );
      const total = subtotal - discountAmount;
      const receiptCode = uniqueReceiptCode();
      const save = db.transaction(() => {
        const receipt = run(
          "INSERT INTO receipts(receipt_code,total_amount,discount,customer_id,cash_tendered) VALUES(?,?,?,?,?)",
          [
            receiptCode,
            total,
            discountAmount,
            customerId || null,
            cashTendered,
          ],
        );
        cart.forEach((i) => {
          run(
            "INSERT INTO receipt_items(receipt_id,sku,item_name,qty_sold,price_sold) VALUES(?,?,?,?,?)",
            [
              receipt.lastInsertRowid,
              i.sku,
              i.item_name,
              i.qty,
              i.selling_price,
            ],
          );
          run("UPDATE products SET quantity=quantity-? WHERE sku=?", [
            i.qty,
            i.sku,
          ]);
        });
        // Khata balance is added once per sale (not once per cart line).
        if (customerId && cashTendered < total)
          run(
            "UPDATE customers SET current_balance=current_balance+? WHERE customer_id=?",
            [total - cashTendered, customerId],
          );
        return receipt.lastInsertRowid;
      });
      const receiptId = save();
      return {
        receiptId,
        receiptCode,
        subtotal,
        discount: discountAmount,
        total,
        change: cashTendered - total,
      };
    },
  );
  ipcMain.handle("hold", (_, cart) =>
    run("INSERT INTO held_carts(cart_data) VALUES(?)", [JSON.stringify(cart)]),
  );
  ipcMain.handle("recall", () =>
    rows("SELECT * FROM held_carts ORDER BY id DESC"),
  );
  ipcMain.handle("recall-one", (_, id) => {
    const item = one("SELECT * FROM held_carts WHERE id=?", [id]);
    run("DELETE FROM held_carts WHERE id=?", [id]);
    return JSON.parse(item.cart_data);
  });
  ipcMain.handle("refund", (_, { sku, qty }) => {
    const p = one("SELECT * FROM products WHERE sku=?", [sku]);
    if (!p) throw new Error("Product not found.");
    run("UPDATE products SET quantity=quantity+? WHERE sku=?", [qty, sku]);
    run("INSERT INTO refunds(sku,qty,amount) VALUES(?,?,?)", [
      sku,
      qty,
      -p.selling_price * qty,
    ]);
    return p;
  });
  ipcMain.handle("stock-in", (_, { supplierId, items, amountPaid }) => {
    const total = items.reduce((s, i) => s + i.purchase_price * i.qty, 0);
    const tx = db.transaction(() => {
      items.forEach((i) => {
        run("UPDATE products SET quantity=quantity+? WHERE sku=?", [
          i.qty,
          i.sku,
        ]);
      });
      if (supplierId && amountPaid < total)
        run(
          "UPDATE suppliers SET current_balance=current_balance+? WHERE supplier_id=?",
          [total - amountPaid, supplierId],
        );
    });
    tx();
    return { total };
  });
  ipcMain.handle("print-receipt", async (_, { receiptId }) => {
    try {
      await sendRaw(buildReceipt(receiptId).toBytes());
      return { ok: true, receiptId };
    } catch (error) {
      logError("print-receipt failed", error);
      return {
        ok: false,
        receiptId,
        error: `Printer unavailable: ${error.message}`,
      };
    }
  });
  // Channel name kept as "void-receipt" so existing code keeps working;
  // the UI now calls this action "Delete".
  ipcMain.handle("void-receipt", (_, receiptId) => {
    const items = rows("SELECT * FROM receipt_items WHERE receipt_id=?", [
      receiptId,
    ]);
    const tx = db.transaction(() => {
      items.forEach((i) =>
        run("UPDATE products SET quantity=quantity+? WHERE sku=?", [
          i.qty_sold,
          i.sku,
        ]),
      );
      run("DELETE FROM receipt_items WHERE receipt_id=?", [receiptId]);
      run("DELETE FROM receipts WHERE receipt_id=?", [receiptId]);
    });
    tx();
    return { ok: true };
  });
  ipcMain.handle("drawer", async () => {
    try {
      await sendRaw(DRAWER_KICK);
      return { ok: true };
    } catch (e) {
      logError("drawer failed", e);
      return { ok: false, error: `Drawer unavailable: ${e.message}` };
    }
  });
  // HID barcode scanners emulate keyboard input and cannot be queried as a
  // separate USB device reliably. The renderer marks the scanner ready only
  // after receiving a barcode sequence ending in Enter.
  ipcMain.handle("hardware", async () => {
    let connected = false;
    try {
      const list = await listPrinters();
      const saved = getSavedPrinter();
      connected =
        list.some((p) => p.name === saved) ||
        list.some((p) =>
          /pos|receipt|thermal|xprinter|ocpp|rongta|epson|tm-/i.test(p.name),
        );
    } catch {}
    return { printer: connected, scanner: false };
  });

  ipcMain.handle("printers-list", async () => {
    const list = await listPrinters();
    return { list, selected: await resolvePrinterName() };
  });

  ipcMain.handle("printer-save", (_, name) => {
    fs.writeFileSync(printerSettingsPath, JSON.stringify({ name }));
    return { ok: true };
  });

  ipcMain.handle("printer-test", async () => {
    try {
      await sendRaw(testReceipt().toBytes());
      return { ok: true };
    } catch (error) {
      logError("printer-test failed", error);
      return { ok: false, error: `Printer unavailable: ${error.message}` };
    }
  });

  // Shows the receipt in a window, so you can check the layout without a printer.
  ipcMain.handle("receipt-preview", (_, payload) => {
    const html = buildReceipt(payload?.receiptId).toHtml();
    const file = path.join(os.tmpdir(), `hamza-pos-receipt-${Date.now()}.html`);
    fs.writeFileSync(file, html);
    const win = new BrowserWindow({
      width: 480,
      height: 900,
      title: "Receipt preview",
      autoHideMenuBar: true,
    });
    win.loadFile(file);
    return { ok: true };
  });
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("console-message", (_, level, message, line, sourceId) =>
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`),
  );
  win.webContents.on("render-process-gone", (_, details) =>
    console.error("Renderer process exited:", details),
  );
  win.webContents.on("unresponsive", () =>
    console.error("Renderer became unresponsive"),
  );
  win.webContents.on("before-input-event", (_, input) => {
    if (
      input.type === "keyDown" &&
      input.key.toLowerCase() === "i" &&
      input.control &&
      input.shift
    )
      win.webContents.toggleDevTools();
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.once("did-finish-load", () =>
      win.webContents.openDevTools({ mode: "detach" }),
    );
  } else win.loadFile(path.join(__dirname, "../dist/index.html"));
}
app.whenReady().then(() => {
  ensureRuntime();
  ensureDatabaseBootstrap();
  // Adds new columns (e.g. receipts.discount) to existing databases.
  migrateDatabase();
  // Register every renderer bridge before creating the window.
  setupIpc();
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
