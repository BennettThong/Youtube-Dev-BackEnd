const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = require(jsonPath);

// Convert to string and escape all newlines for safe .env usage
const singleLine = JSON.stringify(serviceAccount)
  .replace(/\\n/g, '\\\\n')       // Escapes existing \n in private key
  .replace(/\n/g, '\\n');         // Escapes any literal newlines

console.log(singleLine);
