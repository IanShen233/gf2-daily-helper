import crypto from 'crypto';

const API_BASE_URL = 'https://gf2-bbs-api.exiliumgf.com';
const GF2_BBS_URL = 'https://gf2-bbs.exiliumgf.com';
let cachedAesKey: string | null = null;

export interface loginPayload {
    account_name: string;
    passwd: string;
    encryption_key?: string;
    source?: string;
}

interface loginResponse {
    Code: number;
    Message: string;
    data?: {
        account: {
            token: string;
        };
    };
}

interface communityResponse {
    data: {
        list: {
            topic_id: number;
        }[];
    };
}

class LoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LoginError';
    }
}

function md5Hash(input: string): string {
    return crypto.createHash('md5').update(input).digest('hex');
}

function encryptWithAes(plaintext: string, key: string, iv: string): Buffer {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
}

function toUrlSafeBase64(buffer: Buffer): string {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encryptCredential(credential: string, key: string, isPassword: boolean): string {
    if (!credential) {
        throw new LoginError('凭据加密失败: 凭据为空');
    }
    if (!key || Buffer.byteLength(key, 'utf8') !== 16) {
        throw new LoginError('凭据加密失败: AES密钥无效（需为16字节）');
    }
    try {
        const textToEncrypt = isPassword ? md5Hash(credential) : credential;
        const encrypted = encryptWithAes(textToEncrypt, key, key);
        return toUrlSafeBase64(encrypted);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new LoginError(`凭据加密失败: ${msg}`);
    }
}

function extractJsBundleUrl(html: string): string | null {
    const match = html.match(/<script[^>]+src=["']([^"']*app[^"']*\.js[^"']*)["']/);
    if (!match) return null;
    let url = match[1];
    if (url.startsWith('/')) {
        url = GF2_BBS_URL + url;
    }
    return url;
}

function extractAesKeyFromJs(jsContent: string): string | null {
    const match = jsContent.match(/enc\.Utf8\.parse\(["']([^"']+)["']\)/);
    return match ? match[1] : null;
}

async function fetchAesKey(fallbackKey?: string): Promise<string> {
    if (cachedAesKey) {
        return cachedAesKey;
    }

    try {
        const homeResponse = await fetch(GF2_BBS_URL, { signal: AbortSignal.timeout(10000) });
        const homeHtml = await homeResponse.text();

        const jsUrl = extractJsBundleUrl(homeHtml);
        if (!jsUrl) throw new Error('无法从首页解析JS Bundle URL');

        const jsResponse = await fetch(jsUrl, { signal: AbortSignal.timeout(10000) });
        const jsContent = await jsResponse.text();

        const key = extractAesKeyFromJs(jsContent);
        if (!key) throw new Error('无法从JS Bundle提取AES密钥');

        if (Buffer.byteLength(key, 'utf8') !== 16) {
            throw new Error(`提取的密钥长度异常: ${Buffer.byteLength(key, 'utf8')}字节，期望16字节`);
        }

        cachedAesKey = key;
        console.log('AES密钥自动获取成功');
        return cachedAesKey;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (fallbackKey) {
            console.warn(`AES密钥自动获取失败: ${msg}，使用ENCRYPTION_KEY`);
            cachedAesKey = fallbackKey;
            return fallbackKey;
        }
        throw new LoginError(`AES密钥自动获取失败且未设置ENCRYPTION_KEY: ${msg}`);
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise(function (resolve: () => void): void {
        setTimeout(resolve, ms);
    });
}

function getAesDiagnosticHint(errorMessage: string): string {
    if (errorMessage.includes('TokenDecryptAes') || errorMessage.includes('encrypt not full blocks')) {
        return '（可能原因：凭据加密方式与服务端不匹配，请检查AES加密和Base64编码是否正确）';
    }
    return '';
}

function isValidJwtFormat(token: string): boolean {
    return /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

async function Login(payload: loginPayload): Promise<string> {
    if (payload.account_name.indexOf('@') === -1) {
        payload.source = 'phone';
    } else {
        payload.source = 'mail';
    }

    try {
        const aesKey = await fetchAesKey(payload.encryption_key);

        const encryptedPayload = {
            account_name: encryptCredential(payload.account_name, aesKey, false),
            passwd: encryptCredential(payload.passwd, aesKey, true),
            source: payload.source,
        };

        const response = await fetch(`${API_BASE_URL}/login/account`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(encryptedPayload)
        });
        const data = await response.json() as loginResponse;
        if (data.Code !== 0) {
            const hint = getAesDiagnosticHint(data.Message);
            throw new LoginError(`登录失败: ${data.Message}${hint}`);
        }
        const token = data.data?.account?.token;
        if (!token) {
            throw new LoginError('登录失败: 响应中缺少有效token');
        }
        if (!isValidJwtFormat(token)) {
            throw new LoginError('登录失败: 返回的token格式无效，非合法JWT格式');
        }
        console.log('Login success');
        return token;
    } catch (error) {
        if (error instanceof LoginError) {
            throw error;
        }
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        throw new LoginError(`登录失败: ${errorMessage}`);
    }
}

interface exchangeRequestBody {
    exchange_id: number;
}

async function ExchangeItem(exchange_id: number, token: string): Promise<void> {
    const requestBody: exchangeRequestBody = {
        exchange_id: exchange_id,
    };

    try {
        const response = await fetch(`${API_BASE_URL}/community/item/exchange`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(data);
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
        } else {
            console.error('An unknown error occurred');
        }
    }
}

async function SignIn(token: string): Promise<void> {
    const requestBody = {};

    try {
        const response = await fetch(`${API_BASE_URL}/community/task/sign_in`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(data);
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
        } else {
            console.error('An unknown error occurred');
        }
    }
}

async function GetTopicList(): Promise<number[]> {
    try {
        const response = await fetch(`${API_BASE_URL}/community/topic/list?sort_type=2`);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json() as communityResponse;
        const topicList = data.data.list.slice(0, 3);
        const topicIDs: number[] = topicList.map((item: { topic_id: number }) => item.topic_id);
        console.log(topicIDs);
        return topicIDs;
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
        } else {
            console.error('An unknown error occurred');
        }
        return [];
    }
}

async function TopicHandle(topic_id: number, token: string): Promise<void> {
    const requestHeader = {
        'Authorization': token
    };

    try {
        let response = await fetch(`${API_BASE_URL}/community/topic/${topic_id}?id=${topic_id}`, {
            method: 'GET',
            headers: requestHeader
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        let data = await response.json();
        console.log(data);

        response = await fetch(`${API_BASE_URL}/community/topic/like/${topic_id}?id=${topic_id}`, {
            method: 'GET',
            headers: requestHeader
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        data = await response.json();
        console.log(data);

        response = await fetch(`${API_BASE_URL}/community/topic/share/${topic_id}?id=${topic_id}`, {
            method: 'GET',
            headers: requestHeader
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        data = await response.json();
        console.log(data);
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
        } else {
            console.error('An unknown error occurred');
        }
    }
}

export async function DailyTask(userPayload: loginPayload): Promise<void> {
    console.log('Start daily tasks');
    try {
        const [jwtToken, topicList] = await Promise.all([Login(userPayload), GetTopicList()]);
        console.log('Login and get topic list completed');

        try {
            await Promise.all([
                SignIn(jwtToken),
                ...topicList.map(element => TopicHandle(element, jwtToken))
            ]);
            console.log('Daily tasks completed');
        } catch (taskError) {
            console.error('Error completing daily tasks:', taskError instanceof Error ? taskError.message : taskError);
        }

        try {
            const exchangeIDs: number[] = [1, 1, 2, 3, 4, 5, 7, 8];

            for (const element of exchangeIDs) {
                await ExchangeItem(element, jwtToken);
                await delay(1000);
            }
            console.log('Items exchanged');
        } catch (exchangeError) {
            console.error('Error exchanging items:', exchangeError instanceof Error ? exchangeError.message : exchangeError);
        }

    } catch (loginOrListError) {
        if (loginOrListError instanceof LoginError) {
            console.error('登录失败:', loginOrListError.message);
        } else {
            const errMsg = loginOrListError instanceof Error ? loginOrListError.message : String(loginOrListError);
            console.error('获取帖子列表失败:', errMsg);
        }
        throw loginOrListError;
    }
}
