const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = process.env.DATA_PATH || path.join(__dirname, 'data', 'db.json');

function loadDB() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error reading database", e);
    }
    return { users: [], history: {} };
}

function saveDB(db) {
    try {
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving database", e);
    }
}

// Инициализация дефолтного аккаунта Test / parol
let db = loadDB();
if (!db.users.find(u => u.username === 'Test')) {
    db.users.push({ username: 'Test', password: 'parol' });
    saveDB(db);
}

// Проверка пароля (мин 8 символов, 1 заглавная, 1 цифра, 1 спецсимвол из - _ . ! ?)
function validatePassword(pass) {
    const regex = /^(?=.*[A-Z])(?=.*\d)(?=.*[\-_.\!?])[A-Za-z\d\-_.\!?]{8,}$/;
    return regex.test(pass);
}

// Регистрация
app.post('/api/register', (req, res) => {
    let { username, password } = req.body;
    username = username ? username.trim() : '';

    if (!username || !password) {
        return res.status(400).json({ error: "Заполните все поля" });
    }

    const existing = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
        return res.status(400).json({ error: "Данный юзернейм уже занят" });
    }

    // Проверка пароля (если это не дефолтный тестовый вход)
    if (!(username === 'Test' && password === 'parol')) {
        if (!validatePassword(password)) {
            return res.status(400).json({ error: "Пароль должен содержать от 8 символов, 1 заглавную букву, 1 цифру и 1 спецсимвол (- _ . ! ?)" });
        }
    }

    db.users.push({ username, password });
    saveDB(db);
    res.json({ success: true, user: { username } });
});

// Вход
app.post('/api/login', (req, res) => {
    let { username, password } = req.body;
    username = username ? username.trim() : '';

    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.status(400).json({ error: "Неверный юзернейм или пароль" });
    }
    res.json({ success: true, user: { username: user.username } });
});

// Изменение юзернейма
app.post('/api/update-username', (req, res) => {
    const { oldUsername, newUsername } = req.body;
    const trimmedNew = newUsername ? newUsername.trim() : '';

    const user = db.users.find(u => u.username === oldUsername);
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    const exists = db.users.find(u => u.username.toLowerCase() === trimmedNew.toLowerCase() && u !== user);
    if (exists) {
        return res.status(400).json({ error: "Данный юзернейм уже занят" });
    }

    user.username = trimmedNew;
    // перенос истории
    if (db.history[oldUsername]) {
        db.history[trimmedNew] = db.history[oldUsername];
        delete db.history[oldUsername];
    }
    saveDB(db);
    res.json({ success: true, username: trimmedNew });
});

// Изменение пароля
app.post('/api/update-password', (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    const user = db.users.find(u => u.username === username && u.password === oldPassword);
    
    if (!user) {
        return res.status(400).json({ error: "Текущий пароль указан неверно" });
    }

    if (!(username === 'Test' && newPassword === 'parol')) {
        if (!validatePassword(newPassword)) {
            return res.status(400).json({ error: "Новый пароль не соответствует требованиям безопасности" });
        }
    }

    user.password = newPassword;
    saveDB(db);
    res.json({ success: true });
});

// Поиск через Gemini API
app.post('/api/search', async (req, res) => {
    const { query, mode, username } = req.body;
    if (!query) return res.status(400).json({ error: "Пустой запрос" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "API ключ Gemini не настроен в окружении" });
    }

    const promptText = `Ты являешься помощником UniView AI.
Проанализируй университет: ${query}
И помни что нужен только университет, не выдавай другие данные не связанными с университетом по запросу
Верни в формате текста:
- официальное название
- краткую информацию
- официальный сайт
- программы
- требования
- источники
- контакты
${mode === 'full' ? '- требования зависят от 2 способа, этот способ должен давать абсолютно всю инфу про уник, включая направления, пороговые баллы, необходимые документы, условия и рекомендации на какую профессию стоит идти а на какую лучше выбрать другой университет' : '- краткая сводка'}
Не придумывай информацию. Если подтвержденных данных недостаточно - укажи это.
Никогда не используй двойное тире а только одинарное`;

    try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }]
            })
        });

        const data = await response.json();
        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Информация не найдена или ошибка генерации.";

        // Сохранение истории (максимум 10 элементов, FIFO)
        if (username) {
            if (!db.history[username]) db.history[username] = [];
            db.history[username].unshift(query);
            if (db.history[username].length > 10) {
                db.history[username] = db.history[username].slice(0, 10);
            }
            saveDB(db);
        }

        res.json({ success: true, text: resultText, history: username ? db.history[username] : [] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Ошибка запроса к Gemini API" });
    }
});

app.get('/api/history/:username', (req, res) => {
    const username = req.params.username;
    res.json({ history: db.history[username] || [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
