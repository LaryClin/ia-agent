import crypto from "crypto";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

interface RabbitMQMessage {
    content: Buffer | { data?: number[] };
}

export interface Agent {
    address: string;
    name: string;
    description: string;
}

export interface AgentCredentials {
    address: string;
    email: string;
    login: string;
    password: string;
}

export function decrypt(encryptedData: string): string {
    const parts = encryptedData.split(":");
    const iv = Buffer.from(parts.shift() || "", "base64");
    const encryptedText = Buffer.from(parts.join(":"), "base64");
    const key = crypto
        .createHash("sha256")
        .update(process.env.ENCRYPTION_KEY!)
        .digest();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

export function decodeMessage(message: RabbitMQMessage): Agent[] {
    try {
        let buffer: Buffer;

        if (Buffer.isBuffer(message.content)) {
            buffer = message.content;
        } else if (Array.isArray(message.content.data)) {
            buffer = Buffer.from(message.content.data);
        } else if (typeof message.content === "string") {
            buffer = Buffer.from(message.content);
        } else {
            throw new Error("Invalid message format");
        }

        const jsonString = buffer.toString("utf-8");
        const decodedMessage: Agent[] = JSON.parse(jsonString);

        return decodedMessage;
    } catch (error) {
        console.error("Error decoding message:", error);
        throw new Error("Failed to decode message");
    }
}

export function decodeMessageCredentials(
    message: RabbitMQMessage
): AgentCredentials {
    try {
        let buffer: Buffer;

        if (Buffer.isBuffer(message.content)) {
            buffer = message.content;
        } else if (Array.isArray(message.content.data)) {
            buffer = Buffer.from(message.content.data);
        } else if (typeof message.content === "string") {
            buffer = Buffer.from(message.content);
        } else {
            throw new Error("Invalid message format");
        }

        const jsonString = buffer.toString("utf-8");
        const decodedMessage: AgentCredentials = JSON.parse(jsonString);

        // Vérification que tous les champs requis sont présents
        if (
            !decodedMessage.address ||
            !decodedMessage.email ||
            !decodedMessage.login ||
            !decodedMessage.password
        ) {
            throw new Error("Missing required fields in agent credentials");
        }

        return decodedMessage;
    } catch (error) {
        console.error("Error decoding message:", error);
        throw new Error("Failed to decode message");
    }
}
