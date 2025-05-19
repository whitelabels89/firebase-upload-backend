const express = require('express');
const multer = require('multer');
const cors = require("cors"); // ⬅️ Tambahin ini
const { Storage } = require("@google-cloud/storage");
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { google } = require("googleapis");

// Load service account
const serviceAccountBuffer = Buffer.from(process.env.SERVICE_ACCOUNT_KEY_BASE64, "base64");
fs.writeFileSync("serviceAccountKey.json", serviceAccountBuffer);

const serviceAccount = require("./serviceAccountKey.json");


// Init Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'socmed-karya-anak.firebasestorage.app'
});

const bucket = admin.storage().bucket();
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors()); // ⬅️ Ini juga WAJIB
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// Upload middleware
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { cid, title } = req.body;

    if (!file || !cid || !title) {
      return res.status(400).json({ message: 'Missing file, cid, or title.' });
    }

    const filename = `karya/${cid}/${Date.now()}_${file.originalname}`;
    const uploaded = await bucket.upload(file.path, {
      destination: filename,
      public: true,
      metadata: { contentType: file.mimetype }
    });

    fs.unlinkSync(file.path); // hapus file temp

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    const id_karya = `KID-${cid}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    console.log('✅ Uploaded to Firebase:', publicUrl);

    await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid, title, url: publicUrl, id_karya })
    });
    
    res.status(200).json({ message: '✅ Karya berhasil diupload!', url: publicUrl });

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ message: '❌ Gagal upload: ' + err.message });
  }
});

app.post("/hapus-karya", async (req, res) => {
  try {
    const { cid, id_karya } = req.body;
    if (!cid || !id_karya) {
      return res.status(400).json({ success: false, message: "Missing CID or id_karya" });
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

    const sheetId = "1z7ybkdO4eLsV_STdzO8pOVMZNUzdfcScSERyOFNm-GY";
    const tabName = "KARYA_ANAK";
    const sheetIdInternal = 368316898;

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A2:D`,
    });

    const rows = getRes.data.values || [];
    const rowIndex = rows.findIndex(r => r[4] === id_karya);
    if (rowIndex === -1) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    }

    const fileUrl = rows[rowIndex][3];
    try {
      const urlObj = new URL(fileUrl);
      const pathParts = urlObj.pathname.split('/');
      const filename = decodeURIComponent(pathParts.slice(2).join('/')); // ambil karya/QACxxx/...

      console.log("📎 URL dari Sheet:", fileUrl);
      console.log("🧹 Akan menghapus file:", filename);

      console.log("🧹 Deleting file:", filename);
      await bucket.file(filename).delete();
    } catch (err) {
      console.warn("⚠️ Gagal parsing atau menghapus file:", err.message);
    }

    // Hapus baris dari sheettttt
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetIdInternal,
              dimension: "ROWS",
              startIndex: rowIndex + 1,
              endIndex: rowIndex + 2,
            },
          },
        }],
      },
    });

    res.json({ success: true });

  } catch (e) {
    console.error("❌ Gagal hapus karya (fatal):", e);
    if (e.response && e.response.data) {
      console.error("📦 Error detail dari Google API:", e.response.data);
    }
    res.status(500).json({ success: false, message: "Internal error", error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send('🔥 Firebase Upload Server Ready');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
