'use strict';
// Фейковый Ollama для тестов: «находит» сущности из фиксированного списка, если они есть в тексте.
// Плюс специально возвращает галлюцинацию и стоп-слово — они должны быть отброшены.
const http = require('http');
const fs = require('fs');

const KNOWN = [
  { text: 'ООО «Ромашка»', type: 'ORG', canonical: 'Ромашка' },
  { text: 'Ромашка', type: 'ORG', canonical: 'Ромашка' },
  { text: 'АО «Альфа»', type: 'ORG', canonical: 'Альфа' },
  { text: 'Иванова Ивана Ивановича', type: 'PER', canonical: 'Иванов Иван Иванович' },
  { text: 'Иванов Иван Иванович', type: 'PER', canonical: 'Иванов Иван Иванович' },
  { text: 'Иванов И.И.', type: 'PER', canonical: 'Иванов И.И.' },
  { text: 'Сидоровой А.П.', type: 'PER', canonical: 'Сидорова А.П.' },
  { text: '125009, г. Москва, ул. Тверская, д. 7, офис 12', type: 'ADDR', canonical: '125009, г. Москва, ул. Тверская, д. 7, офис 12' },
  { text: '101000, г. Москва, ул. Мясницкая, д. 1', type: 'ADDR', canonical: '101000, г. Москва, ул. Мясницкая, д. 1' },
  { text: '№ 15/2024-КП', type: 'DOC', canonical: '15/2024-КП' },
];

const port = Number(process.argv[2] || 11435);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }));
    if (req.url === '/api/chat') {
      const msg = JSON.parse(body).messages.find((m) => m.role === 'user').content;
      const text = msg.split('"""')[1] || '';
      if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, `${text}\n----\n`);
      const entities = KNOWN.filter((e) => text.toLowerCase().includes(e.text.toLowerCase()));
      entities.push({ text: 'Галлюцинация Несуществующая', type: 'PER', canonical: 'x' });
      entities.push({ text: 'Заказчик', type: 'ORG', canonical: 'Заказчик' });
      return res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify({ entities }) }, done: true }));
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log(`mock ollama on ${port}`));
