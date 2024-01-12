import { logBeforeTimeout, logger, Sqs } from '@firestone-hs/aws-lambda-utils';
import { Input } from './sqs-event';

const sqs = new Sqs();

export default async (event, context): Promise<any> => {
	if (!event.body?.length) {
		logger.log('Missing body', event);
		return {
			statusCode: 400,
		};
	}

	const cleanup = logBeforeTimeout(context);
	const input: Input = JSON.parse(event.body);
	logger.debug('processing review', input.reviewId);
	await sqs.sendMessageToQueue(input, process.env.SQS_URL);
	cleanup();
	return { statusCode: 200, body: '' };
};
