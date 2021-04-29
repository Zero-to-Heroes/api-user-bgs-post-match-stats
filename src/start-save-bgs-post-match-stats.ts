import { Sqs } from './db/sqs';
import { Input } from './sqs-event';

const sqs = new Sqs();

export default async (event): Promise<any> => {
	console.log(event);
	const input: Input = JSON.parse(event.body);
	await sqs.sendMessageToQueue(input, process.env.SQS_URL);
	return { statusCode: 200, body: '' };
};
