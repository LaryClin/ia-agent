export const config = {
    rabbitmq: {
        url: process.env.RABBITMQ_URL,
        QUEUE_AGENT_CREATION: "agent_creation",
        QUEUE_AGENT_CREDENTIALS: "agent_credentials",
    },
};
