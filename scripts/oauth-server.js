import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import log from '../src/utils/logger.js';

// 加载 .env 配置
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const STATE = crypto.randomUUID();

const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
];

function generateAuthUrl(port) {
    const params = new URLSearchParams({
        access_type: 'offline',
        client_id: CLIENT_ID,
        prompt: 'consent',
        redirect_uri: `http://localhost:${port}/oauth-callback`,
        response_type: 'code',
        scope: SCOPES.join(' '),
        state: STATE
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code, port) {
    const postData = new URLSearchParams({
        code: code,
        client_id: CLIENT_ID,
        redirect_uri: `http://localhost:${port}/oauth-callback`,
        grant_type: 'authorization_code'
    });

    if (CLIENT_SECRET) {
        postData.append('client_secret', CLIENT_SECRET);
    }

    const data = postData.toString();

    // 构建 axios 配置，包含代理设置
    const axiosConfig = {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(data)
        },
        data: data,
        timeout: 30000
    };

    // 如果配置了代理，则使用代理
    const proxyUrl = process.env.PROXY;
    if (proxyUrl) {
        try {
            log.info(`使用代理: ${proxyUrl}`);
            // 使用 HttpsProxyAgent 处理 HTTPS 请求的代理
            const httpsAgent = new HttpsProxyAgent(proxyUrl);
            axiosConfig.httpsAgent = httpsAgent;
            axiosConfig.proxy = false; // 禁用 axios 内置的代理，使用 agent 代替
        } catch (error) {
            log.warn(`代理配置解析失败: ${error.message}`);
        }
    }

    try {
        log.info('开始请求 Token...');
        log.info(`请求配置: ${JSON.stringify({ url: axiosConfig.url, hasHttpsAgent: !!axiosConfig.httpsAgent }, null, 2)}`);

        const response = await axios(axiosConfig);

        log.info(`Token 交换成功，状态码: ${response.status}`);
        return response.data;
    } catch (error) {
        // 详细的错误日志
        if (error.response) {
            log.error(`HTTP 错误 ${error.response.status}`);
            log.error(`响应头: ${JSON.stringify(error.response.headers, null, 2)}`);
            log.error(`响应数据: ${JSON.stringify(error.response.data)}`);
            throw new Error(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            log.error(`请求已发送但未收到响应`);
            log.error(`错误信息: ${error.message}`);
            log.error(`错误代码: ${error.code}`);
            throw new Error(`请求失败: ${error.message} (${error.code})`);
        } else {
            log.error(`请求配置错误: ${error.message}`);
            throw error;
        }
    }
}

const server = http.createServer((req, res) => {
    const address = server.address();
    if (!address) {
        log.error('服务器地址为空，无法处理请求');
        res.writeHead(500);
        res.end('Server Error');
        return;
    }
    const port = address.port;
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/oauth-callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (code) {
            log.info('收到授权码，正在交换 Token...');
            exchangeCodeForToken(code, port).then(tokenData => {
                const account = {
                    access_token: tokenData.access_token,
                    refresh_token: tokenData.refresh_token,
                    expires_in: tokenData.expires_in,
                    timestamp: Date.now()
                };

                let accounts = [];
                try {
                    if (fs.existsSync(ACCOUNTS_FILE)) {
                        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
                    }
                } catch (err) {
                    log.warn('读取 accounts.json 失败，将创建新文件');
                }

                accounts.push(account);

                const dir = path.dirname(ACCOUNTS_FILE);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));

                log.info(`Token 已保存到 ${ACCOUNTS_FILE}`);
                //log.info(`过期时间: ${account.expires_in}秒`);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>授权成功！</h1><p>Token 已保存，可以关闭此页面。</p>');

                setTimeout(() => server.close(), 1000);
            }).catch(err => {
                log.error('Token 交换失败:', err.message);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>Token 获取失败</h1><p>查看控制台错误信息</p>');

                setTimeout(() => server.close(), 1000);
            });
        } else {
            log.error('授权失败:', error || '未收到授权码');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>授权失败</h1>');
            setTimeout(() => server.close(), 1000);
        }
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(0, () => {
    const port = server.address().port;
    const authUrl = generateAuthUrl(port);
    log.info(`服务器运行在 http://localhost:${port}`);
    log.info('请在浏览器中打开以下链接进行登录：');
    console.log(`\n${authUrl}\n`);
    log.info('等待授权回调...');
});
