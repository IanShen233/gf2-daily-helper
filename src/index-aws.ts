// aws lambda entrypoint

import { loginPayload, DailyTask } from './service.js';

export async function handler(event: Event) {
    const userPayload: loginPayload = {
        account_name: process.env.ACCOUNT_NAME as string,
        passwd: process.env.PASSWORD as string,
        encryption_key: process.env.ENCRYPTION_KEY,
    };

    await DailyTask(userPayload);

    return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Success' }),
    };
}