require('dotenv').config();
const express = require('express');
const path = require('path');
const { init } = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Simple cookie parser (no dependency)
app.use((req, _res, next) => {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  req.cookies = cookies;
  next();
});

app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

app.use('/api/settings', require('./routes/settings').router);
app.use('/api/summary', require('./routes/summary'));
app.use('/api/shopify', require('./routes/shopify'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/shopee', require('./routes/shopee'));
app.use('/api/manual', require('./routes/manual'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3200;

init().then(() => {
  app.listen(PORT, () => {
    console.log(`SHERO Dashboard running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
