export const config = {
    rabbitmq: {
        username: process.env.RABBITMQ_USERNAME!,
        password: process.env.RABBITMQ_PASSWORD!,
        host: process.env.RABBITMQ_HOST!,
        QUEUE_AGENT_CREATION: "agent_creation",
        QUEUE_AGENT_CREDENTIALS: "agents_extra_data",
    },
};
