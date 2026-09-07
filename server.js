const express = require('express');
const path = require('path');
const app = express();

// public フォルダ内の静的ファイル (HTML, CSS, JS) を配信
app.use(express.static(path.join(__dirname, 'public')));

// すべてのルートアクセスで index.html を返す (SPA 対応)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YouTube Client running on port ${PORT}`);
});
