import type { FastifyInstance } from "fastify";

/**
 * The text is the one the owner approved as is — change it here, word for word,
 * and nowhere else. Both languages on one page, so the single address Apple asks
 * for serves every reader.
 */
const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Политика конфиденциальности Remember</title>
<style>
:root { color-scheme: light dark; --fg: #1c1c1e; --bg: #fff; --link: #0a5bd6; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e5e5ea; --bg: #1c1c1e; --link: #6aa8ff; }
}
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0 auto;
  max-width: 60ch;
  padding: 1rem 1rem 3rem;
  font: 1.0625rem/1.6 -apple-system, system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
h1 { font-size: 1.6rem; line-height: 1.25; }
h2 { font-size: 1.2rem; margin-top: 2rem; }
a { color: var(--link); }
ul { padding-left: 1.25rem; }
li { margin: 0.4rem 0; }
nav { text-align: right; }
hr { margin: 3rem 0; border: 0; border-top: 1px solid; opacity: 0.2; }
</style>
</head>
<body>
<main>
<section id="ru" lang="ru">
<nav><a href="#en" lang="en">English</a></nav>
<h1>Политика конфиденциальности Remember</h1>
<p><em>Редакция от 25 сентября 2026 года</em></p>
<p>Remember — приложение, в котором друзья складывают фото и видео с одного события в общую папку — воспоминание, — а нейросеть монтирует из них ролик. Приложение принадлежит Nox Labs. Сейчас это тестовая версия для небольшой группы друзей, её раздают через TestFlight, и при обновлениях данные в ней могут быть удалены. Ниже — коротко и честно, что происходит с вашими данными.</p>
<h2>Что мы собираем</h2>
<ul>
<li><strong>Почту.</strong> По ней вы входите в приложение: на неё приходит одноразовый код.</li>
<li><strong>Ник и язык</strong>, который вы выбрали.</li>
<li><strong>Фото и видео</strong>, которые вы загружаете, — вместе со служебными данными самого файла: временем съёмки, моделью камеры и местом съёмки, если оно записано в файле.</li>
<li><strong>Описания кадров и расшифровку речи из видео.</strong> Их составляет нейросеть.</li>
<li><strong>Воспоминания:</strong> их названия, даты и список участников.</li>
<li><strong>Токен уведомлений</strong> — чтобы присылать уведомления вам на телефон.</li>
</ul>
<h2>Куда это попадает</h2>
<p>Файлы хранятся в облачном хранилище Google Cloud. Данные аккаунта и воспоминаний — в базе данных в облаке, которым пользуется Nox Labs.</p>
<p>Чтобы описать кадры, расшифровать речь и смонтировать ролик, мы передаём ваши фото и видео в сервис Google — Gemini. Без этого приложение не работает.</p>
<p>Рекламы и аналитики в приложении нет. Ваши данные мы не продаём.</p>
<h2>Кому видно</h2>
<p>Воспоминание видят его участники — те, кого пригласил организатор. Лейблы бывают общие и личные: общие видят все участники, личные — только их владелец.</p>
<h2>Как удалить</h2>
<ul>
<li>Свой кадр вы можете удалить сами. Организатор может удалить любой кадр в воспоминании.</li>
<li>Если вы выйдете из воспоминания, ваши кадры из него удалятся.</li>
<li>Организатор может удалить воспоминание целиком — вместе со всеми кадрами и роликами.</li>
<li>Чтобы удалить всё, что связано с вашей почтой, напишите на <a href="mailto:dev@noxlabs.xyz">dev@noxlabs.xyz</a>. Это мы делаем вручную.</li>
</ul>
<h2>Связь</h2>
<p>Вопросы и просьбы — на <a href="mailto:dev@noxlabs.xyz">dev@noxlabs.xyz</a>.</p>
</section>
<hr>
<section id="en" lang="en">
<nav><a href="#ru" lang="ru">Русский</a></nav>
<h1>Remember Privacy Policy</h1>
<p><em>Last updated: September 25, 2026</em></p>
<p>Remember is an app where friends put photos and videos from the same event into one shared folder, called a memory, and an AI model edits them into a video. Remember belongs to Nox Labs. Right now it's a test version for a small group of friends, shared through TestFlight, so data in it may be deleted when we release updates. Here is what happens to your data.</p>
<h2>What we collect</h2>
<ul>
<li><strong>Your email.</strong> It's how you sign in: we send a one-time code to it.</li>
<li><strong>Your nickname and the language</strong> you chose.</li>
<li><strong>The photos and videos you upload</strong>, along with the details stored in the file itself: when it was taken, the camera model, and the location if the file has one.</li>
<li><strong>Descriptions of your shots and transcripts of speech in your videos.</strong> An AI model writes these.</li>
<li><strong>Your memories:</strong> their titles, dates and who's in them.</li>
<li><strong>A notification token</strong>, so we can send notifications to your phone.</li>
</ul>
<h2>Where it goes</h2>
<p>Your files are kept in Google Cloud storage. Account and memory data is stored in a cloud database that Nox Labs uses.</p>
<p>To describe your shots, transcribe speech and edit the video, we send your photos and videos to Google's Gemini service. The app can't do its job without it.</p>
<p>There are no ads and no analytics in the app. We don't sell your data.</p>
<h2>Who can see it</h2>
<p>A memory is visible to its members, the people the organizer invited. Labels come in two kinds: shared labels every member can see, and personal labels only their owner can see.</p>
<h2>How to delete</h2>
<ul>
<li>You can delete a shot you added. The organizer can delete any shot in the memory.</li>
<li>If you leave a memory, your shots are removed from it.</li>
<li>The organizer can delete a whole memory, together with all its shots and videos.</li>
<li>To delete everything tied to your email, write to <a href="mailto:dev@noxlabs.xyz">dev@noxlabs.xyz</a>. We do this by hand.</li>
</ul>
<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:dev@noxlabs.xyz">dev@noxlabs.xyz</a>.</p>
</section>
</main>
</body>
</html>
`;

/**
 * GET /privacy — the privacy policy Apple requires before an external TestFlight
 * group. Public on purpose: no session check and no database, like /health.
 */
export function privacyRoutes(app: FastifyInstance) {
  app.get("/privacy", (_request, reply) => {
    reply.type("text/html; charset=utf-8").headers({
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      // 'unsafe-inline' rather than a hash: the page is a constant with no input
      // to inject into, and default-src 'none' still shuts out every script,
      // font, image and connection.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    return page;
  });
}
