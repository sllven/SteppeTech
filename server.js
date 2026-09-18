const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Инициализация Gemini API (ключ берется из переменных окружения процесса)
const ai = new GoogleGenAI();

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Создание папки /data и базы данных SQLite
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const dbPath = path.join(dataDir, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к SQLite:', err.message);
    } else {
        console.log('📦 База данных подключена успешно (/data/database.sqlite)');
    }
});

// Создание таблиц (Юзеры и История поиска)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- ЭНДПОИНТЫ АВТОРИЗАЦИИ И ПРОФИЛЯ ---

// Регистрация (проверка на уникальность юзернейма)
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Заполните все поля' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, 
            [username, hashedPassword, 'https://via.placeholder.com/90'], 
            function(err) {
                if (err) {
                    return res.status(400).json({ success: false, error: 'Такой юзернейм уже занят!' });
                }
                res.json({ success: true, user: { username, avatar: 'https://via.placeholder.com/90' } });
            }
        );
    } catch (e) {
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) {
            return res.status(400).json({ success: false, error: 'Неверный юзернейм или пароль' });
        }
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return res.status(400).json({ success: false, error: 'Неверный юзернейм или пароль' });
        }
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
            // Проверка уникальности
            db.get(`SELECT * FROM users WHERE username = ?`, [newUsername], (errCheck, existing) => {
                if (existing) return res.status(400).json({ success: false, error: 'Юзернейм уже занят' });
                
                executeProfileUpdate(newUsername, targetPassword, avatar || user.avatar, currentUsername, res);
            });
        } else {
            executeProfileUpdate(targetUsername, targetPassword, avatar || user.avatar, currentUsername, res);
        }
    });
});

function executeProfileUpdate(newU, newP, newA, oldU, res) {
    db.run(`UPDATE users SET username = ?, password = ?, avatar = ? WHERE username = ?`, 
        [newU, newP, newA, oldU], (err) => {
            if (err) return res.status(500).json({ success: false, error: 'Ошибка обновления' });
            // Обновим также историю
            db.run(`UPDATE history SET username = ? WHERE username = ?`, [newU, oldU]);
            res.json({ success: true, user: { username: newU, avatar: newA } });
        }
    );
}

// --- ИИ ПОИСК УНИВЕРСИТЕТОВ ЧЕРЕЗ GEMINI ---
app.post('/api/search', async (req, res) => {
    const { query, mode = '1', username } = req.body; // mode 1 или 2
    if (!query) return res.status(400).json({ success: false, error: 'Пустой запрос' });

    // Сохранение в историю БД (ограничение до 10 последних записей для юзера)
    if (username) {
        db.run(`INSERT INTO history (username, query) VALUES (?, ?)`, [username, query], () => {
            db.run(`DELETE FROM history WHERE username = ? AND id NOT IN (
                SELECT id FROM history WHERE username = ? ORDER BY created_at DESC LIMIT 10
            )`, [username, username]);
        });
    }

    try {
        let prompt = "";
        if (mode === '1') {
            prompt = `Предоставь подробную информацию об университете "${query}" в строго структурированном виде:
1. Полное название
2. Официальный сайт (ссылка)
3. Инстаграм (ссылка или аккаунт)
4. Контакты (телефон, email)
5. Местоположение (город, адрес)
6. Ссылки на 4-10 реальных фотографий (общежития, главный корпус/универ, кампус, столовая, аудитории) в формате Markdown или списка с прямыми URL картинок.
7. Какие специальности есть (список основных направлений).`;
        } else {
            prompt = `Предоставь глубокий аналитический отчет об университете "${query}":
1. Полное Название
2. Официальный сайт
3. Инстаграм
4. Контакты
5. Местоположение
6. Ссылки на 4-10 фотографий (общежития, универ, кампус, столовая, аудитории).
7. Список специальностей.
8. Экспертные рекомендации: на какие перспективные профессии стоит идти в этот вуз, а на какие идти НЕ стоит и почему.
9. Таблица (в формате Markdown) со следующими колонками: Специальность | Что нужно для ЕНТ (предметы) | Порог на платное | Порог на грант | Нужен ли IELTS (балл).
10. Любая другая полезная информация для абитуриента.`;
        }

        // Вызов Gemini через современный SDK
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        res.json({ success: true, data: response.text });
    } catch (error) {
        console.error('Ошибка Gemini API:', error);
        res.status(500).json({ success: false, error: 'Ошибка генерации ответа от ИИ. Проверьте API ключ.' });
    }
});

// Получение истории пользователя
app.get('/api/history/:username', (req, res) => {
    const { username } = req.params;
    db.all(`SELECT query FROM history WHERE username = ? ORDER BY created_at DESC LIMIT 10`, [username], (err, rows) => {
        if (err) return res.json({ success: false, history: [] });
        res.json({ success: true, history: rows.map(r => r.query) });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер SteppeTech запущен на порту ${PORT}`);
});
