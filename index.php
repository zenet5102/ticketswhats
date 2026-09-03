<?php
$bots = [
  'bot1' => [
    'name' => 'Bot 1',
    'detail' => 'Primer server',
    'base' => '/bot1',
    'fallbackLogin' => '/bot1/login',
    'defaultRedirect' => '/bot1/messages'
  ],
  'bot2' => [
    'name' => 'Bot 2',
    'detail' => 'Second server',
    'base' => '/bot2',
    'fallbackLogin' => '/bot2/login',
    'defaultRedirect' => '/bot2/messages'
  ]
];

$requestedBot = isset($_GET['bot']) ? strtolower(trim((string) $_GET['bot'])) : 'bot1';
$selectedBot = array_key_exists($requestedBot, $bots) ? $requestedBot : 'bot1';
?>
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso WhatsApp</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #647086;
      --line: #d9e0eb;
      --accent: #1f8f68;
      --accent-strong: #147852;
      --danger: #b42318;
      --shadow: 0 18px 50px rgba(23, 32, 51, .12);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(135deg, rgba(31, 143, 104, .13), transparent 36%),
        linear-gradient(315deg, rgba(42, 85, 157, .12), transparent 34%),
        var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
    }

    main {
      width: min(100%, 460px);
      background: var(--panel);
      border: 1px solid rgba(217, 224, 235, .9);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 30px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.12;
      letter-spacing: 0;
    }

    .subtitle {
      margin: 0 0 24px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.45;
    }

    .bot-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 20px;
    }

    .bot-option {
      position: relative;
      display: block;
    }

    .bot-option input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .bot-card {
      min-height: 74px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px;
      cursor: pointer;
      display: grid;
      align-content: center;
      gap: 4px;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
    }

    .bot-name {
      font-weight: 800;
      font-size: 15px;
    }

    .bot-detail {
      color: var(--muted);
      font-size: 13px;
    }

    .bot-option input:checked + .bot-card {
      border-color: var(--accent);
      background: rgba(31, 143, 104, .07);
      box-shadow: 0 0 0 3px rgba(31, 143, 104, .13);
    }

    label.field {
      display: grid;
      gap: 7px;
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 15px;
    }

    input[type="text"],
    input[type="password"] {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      font: inherit;
      color: var(--text);
      background: #fff;
      outline: none;
    }

    input[type="text"]:focus,
    input[type="password"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(31, 143, 104, .14);
    }

    .actions {
      display: grid;
      gap: 12px;
      margin-top: 22px;
    }

    button {
      height: 46px;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: white;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }

    button:hover {
      background: var(--accent-strong);
    }

    button:disabled {
      cursor: wait;
      opacity: .7;
    }

    .server-link {
      justify-self: center;
      color: var(--muted);
      text-decoration: none;
      font-size: 14px;
      font-weight: 700;
    }

    .server-link:hover {
      color: var(--accent-strong);
    }

    .message {
      min-height: 20px;
      margin-top: 14px;
      color: var(--danger);
      font-size: 14px;
      line-height: 1.4;
    }

    @media (max-width: 420px) {
      body {
        padding: 16px;
      }

      main {
        padding: 22px;
      }

      .bot-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Acceso WhatsApp</h1>
    <p class="subtitle">Ingresa con tu usuario y elegi el bot donde queres trabajar.</p>

    <form id="loginForm" autocomplete="on">
      <div class="bot-grid" role="radiogroup" aria-label="Servidor">
        <?php foreach ($bots as $key => $bot): ?>
          <label class="bot-option">
            <input
              type="radio"
              name="bot"
              value="<?php echo htmlspecialchars($key, ENT_QUOTES, 'UTF-8'); ?>"
              <?php echo $key === $selectedBot ? 'checked' : ''; ?>
            >
            <span class="bot-card">
              <span class="bot-name"><?php echo htmlspecialchars($bot['name'], ENT_QUOTES, 'UTF-8'); ?></span>
              <span class="bot-detail"><?php echo htmlspecialchars($bot['detail'], ENT_QUOTES, 'UTF-8'); ?></span>
            </span>
          </label>
        <?php endforeach; ?>
      </div>

      <label class="field" for="username">
        Usuario
        <input id="username" name="username" type="text" autocomplete="username" required autofocus>
      </label>

      <label class="field" for="password">
        Contrasena
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </label>

      <div class="actions">
        <button id="submitBtn" type="submit">Ingresar</button>
        <a id="serverLogin" class="server-link" href="#">Ir al login propio del servidor</a>
      </div>

      <div id="message" class="message" role="alert" aria-live="polite"></div>
    </form>
  </main>

  <script>
    const bots = <?php echo json_encode($bots, JSON_UNESCAPED_SLASHES); ?>;
    const form = document.getElementById('loginForm');
    const submitBtn = document.getElementById('submitBtn');
    const message = document.getElementById('message');
    const serverLogin = document.getElementById('serverLogin');

    function getSelectedBot() {
      const selected = form.querySelector('input[name="bot"]:checked');
      return bots[selected && selected.value] || bots.bot1;
    }

    function setLoading(isLoading) {
      submitBtn.disabled = isLoading;
      submitBtn.textContent = isLoading ? 'Ingresando...' : 'Ingresar';
    }

    function updateServerLink() {
      serverLogin.href = getSelectedBot().fallbackLogin;
    }

    form.addEventListener('change', updateServerLink);
    updateServerLink();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';

      const bot = getSelectedBot();
      const username = form.username.value.trim();
      const password = form.password.value;

      if (!username || !password) {
        message.textContent = 'Completa usuario y contrasena.';
        return;
      }

      setLoading(true);

      try {
        const response = await fetch(`${bot.base}/auth/login`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            username,
            password,
            next: bot.defaultRedirect
          })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'No se pudo iniciar sesion');
        }

        window.location.href = data.redirect || bot.defaultRedirect;
      } catch (error) {
        if (error instanceof TypeError) {
          message.textContent = 'El proxy del bot seleccionado todavia no responde.';
        } else {
          message.textContent = error.message || 'No se pudo iniciar sesion';
        }
      } finally {
        setLoading(false);
      }
    });
  </script>
</body>
</html>
