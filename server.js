require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Инициализация Google Gen AI (ключ берется из переменных окружения .env)
const ai = new GoogleGenAI();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к SQLite базе данных
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Ошибка подключения к SQLite:', err.message);
    else console.log('Подключено к базе данных SQLite.');
});

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        query TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Заполните все поля' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const avatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;
        
        db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, [username, hashedPassword, avatar], function(err) {
            if (err) return res.status(400).json({ success: false, error: 'Юзернейм уже занят' });
            res.json({ success: true, user: { username, avatar } });
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Заполните все поля' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ success: false, error: 'Неверный пароль' });

        res.json({ success: true, user: { username: user.username, avatar: user.avatar } });
    });
});

// Обновление профиля
app.post('/api/update-profile', async (req, res) => {
    const { currentUsername, newUsername, currentPassword, newPassword, avatar } = req.body;

    db.get(`SELECT * FROM users WHERE username = ?`, [currentUsername], async (err, user) => {
        if (err || !user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

        let targetPassword = user.password;
        if (currentPassword && newPassword) {
            const isValid = await bcrypt.compare(currentPassword, user.password);
            if (!isValid) return res.status(400).json({ success: false, error: 'Неверный текущий пароль' });
            targetPassword = await bcrypt.hash(newPassword, 10);
        }

        let targetUsername = currentUsername;
        if (newUsername && newUsername !== currentUsername) {
            db.get(`SELECT * FROM users WHERE username = ?`, [newUsername], (errCheck, existing) => {
                if (existing) return res.status(400).json({ success: false, error: 'Юзернейм уже занят' });
                executeProfileUpdate(newUsername, targetPassword, avatar || user.avatar, currentUsername, res);
            });
        } else {
            executeProfileUpdate(targetUsername, targetPassword, avatar || user.avatar, currentUsername, res);
        }
    });
});

function executeProfileUpdate(newUsername, password, avatar, oldUsername, res) {
    db.run(`UPDATE users SET username = ?, password = ?, avatar = ? WHERE username = ?`, 
        [newUsername, password, avatar, oldUsername], function(err) {
        if (err) return res.status(500).json({ success: false, error: 'Ошибка обновления профиля' });
        
        // Обновляем юзернейм и в истории тоже
        db.run(`UPDATE history SET username = ? WHERE username = ?`, [newUsername, oldUsername], () => {
            res.json({ success: true, user: { username: newUsername, avatar } });
        });
    });
}

// Получение истории поиска
app.get('/api/history/:username', (req, res) => {
    const { username } = req.params;
    db.all(`SELECT DISTINCT query FROM history WHERE username = ? ORDER BY id DESC LIMIT 10`, [username], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: 'Ошибка загрузки истории' });
        res.json({ success: true, history: rows.map(r => r.query) });
    });
});

// Поиск через Gemini API
app.post('/api/search', async (req, res) => {
    const { query, mode, username } = req.body;
    if (!query) return res.status(400).json({ success: false, error: 'Введите запрос' });

    // Сохранение в историю, если пользователь авторизован
    if (username) {
        db.run(`INSERT INTO history (username, query) VALUES (?, ?)`, [username, query]);
    }

    try {
        const prompt = mode === '2' 
            ? `Сделай подробную полную аналитику об университете: "${query}". Включи информацию про проходные баллы, факультеты, гранты, стоимость и перспективы трудоустройства.`
            : `Дай краткий быстрый срез об университете: "${query}" (основные плюсы, направления и особенности).`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        res.json({ success: true, data: response.text });
    } catch (error) {
        console.error('Ошибка Gemini API:', error);
        res.status(500).json({ success: false, error: 'Ошибка генерации ответа от ИИ. Проверьте API ключ в настройках сервера.' });
    }
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
