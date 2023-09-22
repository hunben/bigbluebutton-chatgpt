const Redis = require("redis");
const chatGptService = require("./chatGPT");
require("dotenv").config();

const { MONGO_URI } = process.env;
const MongoDB = require("./mongo-client");

// MongoDB config
const MONGODB_CONFIG = {
  url: MONGO_URI,
};

// Create a new MongoDB client
const mongodb = new MongoDB(MONGODB_CONFIG.url);

// Redis config
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
};

// Redis channel name to listen to
const CHANNEL = process.env.REDIS_CHANNEL;

// Create a client and publisher
const publisher = Redis.createClient(REDIS_CONFIG);
const client = publisher.duplicate();

// Connect to Redis
client.connect();
publisher.connect();

// Connect to MongoDB
mongodb.connect();

// Handle Redis connection errors
client.on("connect", () => {
  console.log("Client Connected to Redis");
});

client.on("error", (err) => {
  console.log("Client Error " + err);
});

publisher.on("connect", () => {
  console.log("Publisher Connected to Redis");
});

publisher.on("error", (err) => {
  console.log("Publisher Error " + err);
});

console.log("ChatGPT is running...");
console.log("ChatGPT command: " + (process.env.CHAT_GPT_COMMAND || "chatgpt"));
console.log("ChatGPT icon: " + (process.env.CHAT_GPT_ICON || "🤖"));

// Subscribe to the channel
client.subscribe(CHANNEL, handleChatGPTCall);

// Handle the chatGPT call

async function handleChatGPTCall(data) {
  if (
    process.env.CHAT_GPT_ENABLE == undefined ||
    process.env.CHAT_GPT_ENABLE != "true"
  )
    return;

  let event;
  try {
    event = JSON.parse(data);

    if (!event?.envelope?.name) return;

    const { envelope } = event;
    const { name } = envelope;

    const body = event.core.body;
    const message = body?.msg?.message;
    let isChatGPTCall = false;
    const chatGPTCommand = process.env.CHAT_GPT_COMMAND || "chatgpt";

    // Check if the message is a chatGPT call case insensitive
    if (
      name === "SendGroupChatMessageMsg" &&
      message?.toLowerCase().startsWith("@" + chatGPTCommand)
    ) {
      isChatGPTCall = true;
    }

    if (!isChatGPTCall) return;

    const userId = envelope?.routing?.userId;

    if (!userId) return;

    // Get the user from the database
    const [user] = await mongodb.query({
      dbName: "meteor",
      collectionName: "users",
      query: { userId: envelope.routing.userId },
    });

    if (!user) return;

    // Check if the user is a moderator
    if (!chatGptService.isChatGPTAllowed(user)) return;

    // Remove the @chatGPT command from the prompt
    const prompt = chatGptService.getPrompt(body.msg.message);

    // if prompt empty send  @chatGPT help
    if (!prompt) {
      sendMessage({
        publisher,
        message: `Prompt is empty!\nPlease use <i style="color:var(--color-primary,#0F70D7);">@${chatGPTCommand} help</i>  to see prompt examples.`,
        event,
        CHANNEL,
      });

      return;
    }

    // if prompt is help send help message
    if (prompt === "help") {
      const newMsg = `Utiliza promts adecuados para chatGPT: \n
      
           `;

      sendMessage({
        publisher,
        message: newMsg,
        event,
        CHANNEL,
      });

      return;
    }
    // Get the response from the chatGPT API
    const response = await chatGptService.getResponseFromChatGPT({ prompt });

    //if response is empty send error message
    if (!response) {
      sendMessage({
        publisher,
        message: "Something went wrong. Please try again later.",
        event,
        CHANNEL,
      });
      return;
    }
    sendMessage({
      publisher,
      message: response,
      event,
      CHANNEL,
    });
    return;
  } catch (error) {
    console.error(error);
    //check if it is axios error
    if (!error?.response?.data) return;
    sendMessage({
      publisher,
      message: error.response.data.error.message,
      event,
      CHANNEL,
    });

    return;
  }
}

function sendMessage({ publisher, message, event, CHANNEL }) {
  try {
    const { envelope } = event;
    const body = event.core.body;
    const newTimeStamp = +new Date();
    envelope.timestamp = newTimeStamp;
    const chatGPTIcon = process.env.CHAT_GPT_ICON || "🤖";
    const chatGPTCommand = process.env.CHAT_GPT_COMMAND || "chatgpt";
    const newMsg = `${chatGPTIcon} <span style="color: blue;">${chatGPTCommand}</span>: ${message}`;
    // Update the message body
    body.msg.message = newMsg;
    event.core.body = body;
    // Publish the new message to the channel
    publisher.publish(CHANNEL, JSON.stringify(event));
  } catch (error) {
    console.error(error);
  }
}
