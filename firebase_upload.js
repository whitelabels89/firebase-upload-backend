const fetch = require('node-fetch');
const express = require('express');
const multer = require('multer');
const cors = require("cors"); // ⬅️ Tambahin ini
const { Storage } = require("@google-cloud/storage");
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { google } = require("googleapis");

// Tulis file kredensial lebih awal
const serviceAccountBuffer = Buffer.from(process.env.SERVICE_ACCOUNT_KEY_BASE64, "base64");
fs.writeFileSync("serviceAccountKey.json", serviceAccountBuffer);

const serviceAccount = require("./serviceAccountKey.json");


// Init Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'socmed-karya-anak.firebasestorage.app'
});

const db = admin.firestore();

const bucket = admin.storage().bucket();
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors()); // ⬅️ Ini juga WAJIB
app.use(express.json({ limit: "5mb" })); // Bisa sesuaikan hingga 10mb kalau perlu
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Ambil data dari Google Sheets PROFILE_ANAK
async function getProfileAnakData() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "serviceAccountKey.json", // ⬅️ INI YANG BELUM ADA
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "PROFILE_ANAK!A1:Z",
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) return [];

  const headers = rows[0];
  return rows.slice(1).map(row => {
    const rowObj = {};
    headers.forEach((header, i) => {
      rowObj[header.trim().toLowerCase()] = (row[i] || "").trim();
    });
    return rowObj;
  });
}

// Endpoint: login manual, menerima identifier (email atau nomor WA) dan password (HYBRID fallback)
const axios = require('axios');
app.post("/login", async (req, res) => {
  const { identifier, password } = req.body;
  console.log("📲 Login request by:", identifier);
  try {
    const isEmail = identifier.includes("@");
    let loginEmail = identifier;

    if (!isEmail) {
      const snapshot = await db.collection("akun").where("wa", "==", identifier).limit(1).get();
      if (!snapshot.empty) {
        loginEmail = snapshot.docs[0].data().email;
        console.log("🔍 Resolved email from WA:", loginEmail);
      } else {
        return res.status(400).json({ error: "Nomor WA tidak ditemukan" });
      }
    } else {
      const snapshot = await db.collection("akun").where("email", "==", identifier.toLowerCase()).limit(1).get();
      if (!snapshot.empty) {
        loginEmail = snapshot.docs[0].data().email;
        console.log("🔍 Resolved email direct:", loginEmail);
      } else {
        return res.status(400).json({ error: "Email tidak ditemukan di database" });
      }
    }

    const firebaseConfig = { apiKey: process.env.FIREBASE_API_KEY };
    const loginRes = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`,
      {
        email: loginEmail,
        password,
        returnSecureToken: true
      }
    ).catch(err => {
      if (err.response && err.response.data && err.response.data.error) {
        return { data: err.response.data };
      }
      throw err;
    });

    if (loginRes.data && loginRes.data.idToken) {
      res.status(200).json({ success: true, token: loginRes.data.idToken });
    } else {
      res.status(400).json({ error: "Gagal login, periksa kembali email/WA dan password Anda." });
    }
  } catch (err) {
    console.error("❌ Error login:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Upload middleware
const upload = multer({ dest: 'uploads/' });

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const { cid, title } = req.body;

    const profileRes = await fetch(`https://firebase-upload-backend.onrender.com/proxy-getprofile?cid=${cid}`);
    const profile = await profileRes.json();
    const nama = profile.nama || "";

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

    const timestamp = Date.now();
    await db.collection("karya_anak").doc(id_karya).set({
      cid,
      nama,
      judul: title,
      url: publicUrl,
      id_karya,
      timestamp
    });
    
    res.status(200).json({ message: '✅ Karya berhasil diupload!', url: publicUrl });

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ message: '❌ Gagal upload: ' + err.message });
  }
});

// Endpoint: Feed Karya - Ambil 10 karya terbaru dari Firestore
app.get("/feed-karya", async (req, res) => {
  try {
    const snapshot = await db.collection("karya_anak")
      .orderBy("timestamp", "desc")
      .limit(10)
      .get();

    const karyaList = snapshot.docs.map(doc => doc.data());
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(karyaList);
  } catch (err) {
    console.error("❌ Gagal mengambil feed karya dari Firestore:", err);
    res.status(500).json({ message: "❌ Gagal ambil feed karya", error: err.message });
  }
});

// Tambahkan di firebase-upload-backend
app.post("/update-profil", async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });

    const result = await response.json();
    console.log("🔁 Result dari ganti-password:", result);
    res.json(result);

  } catch (err) {
    console.error("❌ Gagal update profil:", err);
    res.status(500).json({ message: "❌ Gagal update profil", error: err.message });
  }
});

// Endpoint: update-following via POST dari frontend
app.post("/update-following", async (req, res) => {
  const { cid, followingList } = req.body;

  if (!cid || !Array.isArray(followingList)) {
    return res.status(400).json({ error: 'Data tidak valid' });
  }

  try {
    const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec`;

    // 1. Update FOLLOWING_ANAK
    const followingRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'updateFollowing',
        cid,
        followingList
      })
    });

    const followingResult = await followingRes.json();

    // 2. Update FOLLOWER_ANAK untuk semua target CID
    for (const targetCid of followingList) {
      const followerRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateFollower',
          cid: targetCid,
          followerList: [cid]
        })
      });

      const followerText = await followerRes.text();
      if (!followerText.trim().startsWith("{")) {
        console.error("❌ Invalid response from GAS (FOLLOWER):", followerText.slice(0, 100));
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(followingResult);

  } catch (err) {
    console.error("❌ Error update-following/follower:", err);
    res.status(500).json({ error: "Gagal update following/follower", detail: err.message });
  }
});

// Endpoint: update-follower via POST dari frontend
app.post("/update-follower", async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, action: "updateFollower" })
    });

    const result = await response.json();
    res.json(result);
  } catch (err) {
    console.error("❌ Gagal update follower:", err);
    res.status(500).json({ message: "❌ Gagal update follower", error: err.message });
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
      range: `${tabName}!A2:E`,
    });

    const rows = getRes.data.values || [];
    console.log("📥 Mencari ID_KARYA:", id_karya);
    const rowIndex = rows.findIndex((r, i) => {
      const id = (r[4] || "").toString().trim().toUpperCase();
      console.log(`🔍 Row ${i}:`, id);
      return id === id_karya.toUpperCase();
    });

    if (rowIndex === -1) {
      console.error("❌ ID_KARYA tidak ditemukan di sheet");
      return res.status(404).json({ success: false, message: "ID_KARYA tidak ditemukan di sheet" });
    }

    let deleted = false;
    try {
      const fileUrl = rows[rowIndex][3];
      console.log("📦 fileUrl dari Sheet:", fileUrl);
      if (!fileUrl || typeof fileUrl !== "string" || !fileUrl.startsWith("http")) {
        throw new Error("fileUrl tidak valid: " + fileUrl);
      }
      const urlObj = new URL(fileUrl);
      const pathParts = urlObj.pathname.split('/');
      const filename = decodeURIComponent(pathParts.slice(2).join('/'));

      console.log("🧹 Deleting file:", filename);
      await bucket.file(filename).delete();
      deleted = true;
      // Logging output rowIndex, filename, and deleted before res.json
      console.log("✅ rowIndex ditemukan:", rowIndex);
      console.log("✅ filename parsed:", filename);
      console.log("✅ deleted status:", deleted);
    } catch (err) {
      console.warn("⚠️ Gagal menghapus file:", err.message);
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

    res.json({
      success: true,
      message: deleted ? "Berhasil hapus karya dan file" : "Berhasil hapus karya (file tidak ditemukan)"
    });

  } catch (e) {
    console.error("❌ Gagal hapus karya (fatal):", e);
    if (e.response && e.response.data) {
      console.error("📦 Error detail dari Google API:", e.response.data);
    }
    res.status(500).json({ success: false, message: "Internal error", error: e.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET daftar following)
app.get("/proxy-following", async (req, res) => {
  const { cid, action } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}&action=${action || "getfollowing"}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error("❌ Invalid response from GAS (FOLLOWING):", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("❌ Proxy FOLLOWING Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET daftar follower)
app.get("/proxy-follower", async (req, res) => {
  const { cid, action } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}&action=${action || "getfollower"}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error("❌ Invalid response from GAS (FOLLOWER):", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (err) {
    console.error("❌ Proxy FOLLOWER Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy endpoint untuk bypass CORS ke Google Apps Script (GET profil by CID)
app.get('/proxy-getprofile', async (req, res) => {
  const { cid } = req.query;
  if (!cid) return res.status(400).json({ error: "Missing cid" });

  const url = `https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec?cid=${cid}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
      console.error("❌ Invalid response from GAS (PROFILE):", text.slice(0, 100));
      return res.status(500).json({ error: "Invalid response from Google Apps Script", preview: text.slice(0, 100) });
    }

    let profileData = JSON.parse(text);

    // Tambahkan role dari Firestore jika ada
    try {
      const docSnap = await db.collection("akun").doc(cid).get();
      if (docSnap.exists) {
        profileData.role = docSnap.data().role || "";
      }
    } catch (firestoreErr) {
      console.warn("⚠️ Gagal ambil role dari Firestore:", firestoreErr.message);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(profileData);
  } catch (err) {
    console.error("❌ Proxy GETPROFILE Error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});

// Proxy untuk login ke Google Apps Script (validasi via Sheets)
app.post("/proxy-login-sheet", async (req, res) => {
  try {
    const response = await fetch("https://script.google.com/macros/s/AKfycbx5cPx2YQzYLbjMzFJPwIEr_bMsm4VGB8OA-04p33hnuXK61Mm36U04W3IrihbsIDukhw/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, action: "loginSheet" }),
    });

    const result = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result);
  } catch (err) {
    console.error("❌ Proxy login sheet error:", err);
    res.status(500).json({ error: "Proxy gagal", detail: err.message });
  }
});


app.get('/', (req, res) => {
  res.send('🔥 Firebase Upload Server Ready');
});

// Fungsi: Membuat atau update user email/password di Firebase Auth
const { getAuth } = require("firebase-admin/auth");
async function ensureEmailPasswordUser(email, password) {
  const auth = getAuth();
  try {
    const user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password });
    console.log(`🔐 Updated password for existing user ${email}`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await auth.createUser({ email, password });
      console.log(`🆕 Created new user with email ${email}`);
    } else {
      console.error('❌ Firebase Admin Error:', err);
      throw err;
    }
  }
}

// Endpoint: ganti-password
app.post("/ganti-password", async (req, res) => {
  try {
    const { cid, email, password: newPassword } = req.body;
    if (!cid || !email || !newPassword) {
      return res.status(400).json({ success: false, message: "CID, email, dan password wajib diisi." });
    }
    console.log("📥 Ganti Password Diterima:", { cid, email, password: newPassword });

    // PATCH: Update Sheet PROFILE_ANAK dan Firestore terlebih dahulu agar hybrid login aktif
    const authSheets = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheetsClient = google.sheets({ version: "v4", auth: await authSheets.getClient() });

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = "PROFILE_ANAK";

    // Ambil data
    const getSheet = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z`,
    });
    const rows = getSheet.data.values;
    if (!rows || rows.length === 0) throw new Error("Sheet kosong");

    const headers = rows[0];
    // Cari kolom CID
    const cidIndex = headers.findIndex(h => h.toLowerCase() === "cid");
    // Cari baris berdasarkan CID
    const rowIndex = rows.findIndex((row, i) => i > 0 && row[cidIndex] === cid);
    if (rowIndex === -1) {
      console.error("❌ Row dengan CID tidak ditemukan:", cid);
      return res.status(404).json({ success: false, message: "CID tidak ditemukan di sheet" });
    }

    // Cari kolom password, migrated, email (dan tambahkan email jika belum ada)
    const passwordCol = headers.findIndex(h => h.toLowerCase() === "password");
    const migratedCol = headers.findIndex(h => h.toLowerCase() === "migrated");
    let emailCol = headers.findIndex(h => h.toLowerCase() === "email");

    if (emailCol === -1) {
      headers.push("Email");
      emailCol = headers.length - 1;
      rows[0] = headers;
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    }

    // Update kolom password, migrated, dan email menggunakan batchUpdate
    const updates = [];

    // Update kolom password
    if (passwordCol >= 0) {
      const colLetter = String.fromCharCode(65 + passwordCol);
      updates.push({
        range: `${sheetName}!${colLetter}${rowIndex + 1}`,
        values: [[newPassword]],
      });
    }

    // Update kolom migrated
    if (migratedCol >= 0) {
      const colLetter = String.fromCharCode(65 + migratedCol);
      updates.push({
        range: `${sheetName}!${colLetter}${rowIndex + 1}`,
        values: [["TRUE"]],
      });
    }

    // Update kolom email
    if (emailCol >= 0) {
      const colLetter = String.fromCharCode(65 + emailCol);
      updates.push({
        range: `${sheetName}!${colLetter}${rowIndex + 1}`,
        values: [[email]],
      });
    }

    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates,
      },
    });

    // Simpan juga ke Firestore
    await db.collection("akun").doc(cid).set({
      email,
      migrated: true,
    }, { merge: true });

    // Setelah Sheet/Firestore, update password resmi via Firebase Admin SDK
    await ensureEmailPasswordUser(email, newPassword);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Gagal proses ganti password:", err);
    res.status(500).json({ success: false, message: "Internal error", error: err.message });
  }
});

// Endpoint: simpan-email ke Google Sheets dan Firestore
app.post("/simpan-email", async (req, res) => {
  try {
    const { cid, email, nama } = req.body;
    if (!cid || !email) {
      return res.status(400).json({ success: false, message: "Missing cid or email." });
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: "serviceAccountKey.json",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = "PROFILE_ANAK";

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:Z`,
    });

    const rows = getRes.data.values || [];
    if (rows.length === 0) throw new Error("Sheet kosong.");

    const headers = rows[0];
    let emailColIndex = headers.findIndex(h => h.toLowerCase() === "email");

    // Tambahkan kolom Email jika belum ada
    if (emailColIndex === -1) {
      headers.push("Email");
      emailColIndex = headers.length - 1;
      rows[0] = headers;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    }

    // Temukan baris sesuai CID
    const cidColIndex = headers.findIndex(h => h.toLowerCase() === "cid");
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[cidColIndex] === cid);
    if (rowIndex === -1) throw new Error("CID tidak ditemukan.");

    // Update email di baris yang ditemukan
    const updateRange = `${sheetName}!${String.fromCharCode(65 + emailColIndex)}${rowIndex + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "RAW",
      requestBody: { values: [[email]] }
    });

    // Tambahkan/Update di Firestore
    await db.collection("akun").doc(cid).set({
      email,
      nama,
      role: "user"
    }, { merge: true });

    res.json({ success: true, message: "✅ Email berhasil disimpan ke Sheet & Firestore" });

  } catch (err) {
    console.error("❌ Gagal simpan email:", err);
    res.status(500).json({ success: false, message: "❌ Gagal simpan email", error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Endpoint: Ambil CID berdasarkan nomor WhatsApp
app.get('/proxy-get-cid-by-wa', async (req, res) => {
  const { wa } = req.query;
  if (!wa) return res.status(400).json({ error: "Missing wa" });
  try {
    // Cari dokumen akun dengan field wa = nomor wa
    const snapshot = await db.collection("akun").where("wa", "==", wa).limit(1).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const cid = doc.id;
      res.json({ cid });
    } else {
      res.json({ cid: null });
    }
  } catch (err) {
    console.error("❌ Gagal mengambil CID dari WA:", err);
    res.status(500).json({ error: "Gagal mengambil CID dari WA", detail: err.message });
  }
});
// --- Fungsi loginWithGoogle (frontend, bukan backend) ---
// Ganti seluruh isi fungsi loginWithGoogle sesuai permintaan:
async function loginWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({
      hd: "queensacademy.id",
      continueUrl: "https://queensacademy.id/dashboard.html"
    });
    const result = await signInWithPopup(auth, provider);
    const email = result.user.email;

    const wa = localStorage.getItem("wa_migrated") || "";
    const password = localStorage.getItem("pass_migrated") || "";

    const res = await fetch(`${BACKEND_URL}/proxy-login-gmail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, wa, password }),
    });

    const text = await res.text();
    console.log("🧪 Raw response from Gmail login:", text);
    const data = JSON.parse(text);

    if (data && data.cid) {
      localStorage.setItem("cid_login", data.cid);
      window.location.href = `/dashboard.html?cid=${data.cid}`;
    } else {
      throw new Error("CID tidak ditemukan dalam response");
    }
  } catch (err) {
    console.error("❌ Login Gmail gagal:", err);
    alert("Gagal login dengan Gmail. Silakan coba lagi.");
  }
}