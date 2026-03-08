<?php
declare(strict_types=1);

session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'domain' => '',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax'
]);
session_start();

header('Content-Type: application/json; charset=utf-8');

const MAIN_ADMIN_USERNAME = 'admin';
const MAIN_ADMIN_PASSWORD = 'James123';
const DEFAULT_CASHIER_USERNAME = 'cashier';
const DEFAULT_CASHIER_PASSWORD = 'cashier123';

function json_response(int $status, array $payload): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function get_db(): PDO {
    $dataDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data';
    if (!is_dir($dataDir) && !mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
        json_response(500, ['message' => 'Datamap kon niet worden aangemaakt.']);
    }

    $dbPath = $dataDir . DIRECTORY_SEPARATOR . 'app.sqlite';
    $pdo = new PDO('sqlite:' . $dbPath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ("admin","cashier")),
            is_main_admin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS products (
            barcode TEXT PRIMARY KEY,
            artist TEXT NOT NULL,
            album TEXT NOT NULL,
            purchase_price REAL NOT NULL DEFAULT 0,
            sale_price REAL NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )'
    );

    seed_defaults($pdo);
    return $pdo;
}

function seed_defaults(PDO $pdo): void {
    $stmt = $pdo->prepare('SELECT username, is_main_admin FROM users WHERE username = :username LIMIT 1');
    $stmt->execute([':username' => MAIN_ADMIN_USERNAME]);
    $admin = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$admin) {
        $insert = $pdo->prepare(
            'INSERT INTO users (username, password_hash, role, is_main_admin, created_at)
             VALUES (:username, :password_hash, "admin", 1, :created_at)'
        );
        $insert->execute([
            ':username' => MAIN_ADMIN_USERNAME,
            ':password_hash' => password_hash(MAIN_ADMIN_PASSWORD, PASSWORD_DEFAULT),
            ':created_at' => gmdate('c')
        ]);
    } elseif ((int)$admin['is_main_admin'] !== 1) {
        $fix = $pdo->prepare('UPDATE users SET is_main_admin = 1, role = "admin" WHERE username = :username');
        $fix->execute([':username' => MAIN_ADMIN_USERNAME]);
    }

    $cashierCheck = $pdo->prepare('SELECT username FROM users WHERE username = :username LIMIT 1');
    $cashierCheck->execute([':username' => DEFAULT_CASHIER_USERNAME]);
    if (!$cashierCheck->fetch(PDO::FETCH_ASSOC)) {
        $insertCashier = $pdo->prepare(
            'INSERT INTO users (username, password_hash, role, is_main_admin, created_at)
             VALUES (:username, :password_hash, "cashier", 0, :created_at)'
        );
        $insertCashier->execute([
            ':username' => DEFAULT_CASHIER_USERNAME,
            ':password_hash' => password_hash(DEFAULT_CASHIER_PASSWORD, PASSWORD_DEFAULT),
            ':created_at' => gmdate('c')
        ]);
    }
}

function get_json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return [];
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function current_user(): ?array {
    if (empty($_SESSION['user']) || !is_array($_SESSION['user'])) return null;
    return $_SESSION['user'];
}

function require_user(): array {
    $user = current_user();
    if (!$user) json_response(401, ['message' => 'Niet ingelogd.']);
    return $user;
}

function require_main_admin(): array {
    $user = require_user();
    if (empty($user['isMainAdmin'])) json_response(403, ['message' => 'Alleen hoofd-admin heeft toegang.']);
    return $user;
}

function normalize_username(string $username): string {
    return strtolower(trim($username));
}

function parse_path(): array {
    $uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php')), '/');
    $path = str_replace('\\', '/', $uriPath);
    if ($scriptDir !== '' && $scriptDir !== '/' && strpos($path, $scriptDir) === 0) {
        $path = substr($path, strlen($scriptDir));
    }
    $path = '/' . ltrim($path, '/');
    $segments = array_values(array_filter(explode('/', trim($path, '/')), static fn($s) => $s !== ''));
    return $segments;
}

try {
    $pdo = get_db();
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $segments = parse_path();

    if ($method === 'POST' && $segments === ['login']) {
        $body = get_json_body();
        $username = normalize_username((string)($body['username'] ?? ''));
        $password = (string)($body['password'] ?? '');

        if ($username === '' || $password === '') {
            json_response(422, ['message' => 'Gebruikersnaam en wachtwoord zijn verplicht.']);
        }

        $stmt = $pdo->prepare('SELECT username, password_hash, role, is_main_admin FROM users WHERE username = :username LIMIT 1');
        $stmt->execute([':username' => $username]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || !password_verify($password, (string)$row['password_hash'])) {
            json_response(401, ['message' => 'Gebruikersnaam of wachtwoord is onjuist.']);
        }

        session_regenerate_id(true);
        $_SESSION['user'] = [
            'username' => (string)$row['username'],
            'role' => (string)$row['role'],
            'isMainAdmin' => ((int)$row['is_main_admin'] === 1),
            'loginTime' => gmdate('c')
        ];
        json_response(200, ['user' => $_SESSION['user']]);
    }

    if ($method === 'POST' && $segments === ['logout']) {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], (bool)$params['secure'], (bool)$params['httponly']);
        }
        session_destroy();
        json_response(200, ['success' => true]);
    }

    if ($method === 'GET' && $segments === ['me']) {
        $user = current_user();
        if (!$user) json_response(401, ['message' => 'Niet ingelogd.']);
        json_response(200, ['user' => $user]);
    }

    if ($method === 'GET' && $segments === ['users']) {
        require_main_admin();
        $stmt = $pdo->query('SELECT username, role, is_main_admin FROM users ORDER BY username COLLATE NOCASE ASC');
        $users = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $users[] = [
                'username' => (string)$row['username'],
                'role' => (string)$row['role'],
                'isMainAdmin' => ((int)$row['is_main_admin'] === 1)
            ];
        }
        json_response(200, ['users' => $users]);
    }

    if ($method === 'GET' && $segments === ['products']) {
        require_user();
        $stmt = $pdo->query(
            'SELECT barcode, artist, album, purchase_price, sale_price, stock, created_at, updated_at
             FROM products ORDER BY artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC'
        );
        $products = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $products[] = [
                'barcode' => (string)$row['barcode'],
                'artist' => (string)$row['artist'],
                'album' => (string)$row['album'],
                'purchasePrice' => (float)$row['purchase_price'],
                'salePrice' => (float)$row['sale_price'],
                'stock' => (int)$row['stock'],
                'createdAt' => $row['created_at'] !== null ? (string)$row['created_at'] : null,
                'updatedAt' => $row['updated_at'] !== null ? (string)$row['updated_at'] : null
            ];
        }
        json_response(200, ['products' => $products]);
    }

    if ($method === 'PUT' && $segments === ['products']) {
        require_user();
        $body = get_json_body();
        $incoming = $body['products'] ?? null;
        if (!is_array($incoming)) {
            json_response(422, ['message' => 'Ongeldige productpayload.']);
        }

        $normalized = [];
        foreach ($incoming as $item) {
            if (!is_array($item)) continue;
            $barcode = trim((string)($item['barcode'] ?? ''));
            if ($barcode === '') continue;
            $normalized[] = [
                'barcode' => $barcode,
                'artist' => trim((string)($item['artist'] ?? '')),
                'album' => trim((string)($item['album'] ?? '')),
                'purchasePrice' => (float)($item['purchasePrice'] ?? 0),
                'salePrice' => (float)($item['salePrice'] ?? 0),
                'stock' => (int)($item['stock'] ?? 0),
                'createdAt' => isset($item['createdAt']) ? (string)$item['createdAt'] : null,
                'updatedAt' => isset($item['updatedAt']) ? (string)$item['updatedAt'] : null
            ];
        }

        $pdo->beginTransaction();
        try {
            $pdo->exec('DELETE FROM products');
            $insert = $pdo->prepare(
                'INSERT INTO products (barcode, artist, album, purchase_price, sale_price, stock, created_at, updated_at)
                 VALUES (:barcode, :artist, :album, :purchase_price, :sale_price, :stock, :created_at, :updated_at)'
            );
            foreach ($normalized as $product) {
                $insert->execute([
                    ':barcode' => $product['barcode'],
                    ':artist' => $product['artist'],
                    ':album' => $product['album'],
                    ':purchase_price' => $product['purchasePrice'],
                    ':sale_price' => $product['salePrice'],
                    ':stock' => $product['stock'],
                    ':created_at' => $product['createdAt'],
                    ':updated_at' => $product['updatedAt']
                ]);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        json_response(200, ['success' => true, 'count' => count($normalized)]);
    }

    if ($method === 'POST' && $segments === ['users']) {
        require_main_admin();
        $body = get_json_body();
        $username = normalize_username((string)($body['username'] ?? ''));
        $password = trim((string)($body['password'] ?? ''));
        $role = ((string)($body['role'] ?? 'cashier')) === 'admin' ? 'admin' : 'cashier';

        if ($username === '' || strlen($username) < 3) {
            json_response(422, ['message' => 'Gebruikersnaam moet minimaal 3 tekens zijn.']);
        }
        if (!preg_match('/^[a-z0-9._-]+$/', $username)) {
            json_response(422, ['message' => 'Gebruik alleen letters, cijfers, punt, streepje of underscore.']);
        }
        if ($password === '' || strlen($password) < 6) {
            json_response(422, ['message' => 'Wachtwoord moet minimaal 6 tekens zijn.']);
        }

        $check = $pdo->prepare('SELECT username FROM users WHERE username = :username LIMIT 1');
        $check->execute([':username' => $username]);
        if ($check->fetch(PDO::FETCH_ASSOC)) {
            json_response(409, ['message' => 'Deze gebruikersnaam bestaat al.']);
        }

        $insert = $pdo->prepare(
            'INSERT INTO users (username, password_hash, role, is_main_admin, created_at)
             VALUES (:username, :password_hash, :role, 0, :created_at)'
        );
        $insert->execute([
            ':username' => $username,
            ':password_hash' => password_hash($password, PASSWORD_DEFAULT),
            ':role' => $role,
            ':created_at' => gmdate('c')
        ]);
        json_response(201, ['success' => true]);
    }

    if ($method === 'DELETE' && count($segments) === 2 && $segments[0] === 'users') {
        require_main_admin();
        $username = normalize_username(urldecode((string)$segments[1]));
        if ($username === MAIN_ADMIN_USERNAME) {
            json_response(422, ['message' => 'Hoofd-admin kan niet verwijderd worden.']);
        }

        $delete = $pdo->prepare('DELETE FROM users WHERE username = :username');
        $delete->execute([':username' => $username]);
        if ($delete->rowCount() < 1) {
            json_response(404, ['message' => 'Gebruiker niet gevonden.']);
        }
        json_response(200, ['success' => true]);
    }

    json_response(404, ['message' => 'Endpoint niet gevonden.']);
} catch (Throwable $e) {
    json_response(500, ['message' => 'Serverfout.', 'error' => $e->getMessage()]);
}
