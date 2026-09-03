const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const fs = require("fs");

function loadEnv() {
  if (!fs.existsSync(".env")) return;

  const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const i = trimmed.indexOf("=");

    if (i === -1) continue;

    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const CONFIG = {
  host: process.env.MC_HOST || "pelmeniicc__.aternos.me",
  port: Number(process.env.MC_PORT || 33867),
  username: process.env.MC_USERNAME || "PelmeniiccBot",
  version: process.env.MC_VERSION || "26.2",
  owner: process.env.OWNER_USERNAME || "",
  geminiKey: process.env.GEMINI_API_KEY || ""
};

const GEMINI_MODEL = "gemini-3.1-flash-lite";

let bot;
let followTimer = null;
let reconnectTimer = null;
let processing = false;
let lastDestination = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function stopFollowing() {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }

  if (bot?.pathfinder) {
    try {
      bot.pathfinder.setGoal(null);
    } catch {}
  }
}

function getOwnerEntity() {
  return bot?.players?.[CONFIG.owner]?.entity || null;
}

function nearbyPlayers() {
  if (!bot?.entity) return [];

  return Object.values(bot.players || {})
    .filter(p => p?.username && p.entity)
    .map(p => ({
      username: p.username,
      distance: Number(
        bot.entity.position.distanceTo(p.entity.position).toFixed(1)
      ),
      position: {
        x: Number(p.entity.position.x.toFixed(1)),
        y: Number(p.entity.position.y.toFixed(1)),
        z: Number(p.entity.position.z.toFixed(1))
      }
    }))
    .sort((a, b) => a.distance - b.distance);
}

function inventorySummary() {
  if (!bot) return [];

  return bot.inventory.items().map(item => ({
    name: item.name,
    displayName: item.displayName,
    count: item.count
  }));
}

function botState() {
  if (!bot?.entity) return {};

  return {
    botPosition: {
      x: Number(bot.entity.position.x.toFixed(1)),
      y: Number(bot.entity.position.y.toFixed(1)),
      z: Number(bot.entity.position.z.toFixed(1))
    },
    health: bot.health,
    food: bot.food,
    owner: CONFIG.owner,
    nearbyPlayers: nearbyPlayers(),
    inventory: inventorySummary(),
    previousDestination: lastDestination
  };
}

async function askGemini(username, text) {
  if (!CONFIG.geminiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const systemPrompt = `
You control a Minecraft Java bot.

The bot belongs to player "${CONFIG.owner}".

Interpret natural Minecraft instructions from the owner.

Return ONLY valid JSON.

Available actions:

say:
{"action":"say","message":"text"}

follow:
{"action":"follow","player":"username","distance":2}

come:
{"action":"come","player":"username"}

move:
{"action":"move","x":100,"y":64,"z":200,"radius":1}

stop:
{"action":"stop"}

look_player:
{"action":"look_player","player":"username"}

look_position:
{"action":"look_position","x":100,"y":64,"z":200}

inventory:
{"action":"inventory"}

position:
{"action":"position"}

Multiple actions:
{"actions":[
  {"action":"come","player":"${CONFIG.owner}"},
  {"action":"follow","player":"${CONFIG.owner}","distance":2}
]}

Rules:

- Never produce Minecraft slash commands.
- Never attack players.
- Never destroy blocks.
- Never place blocks.
- Never drop items.
- Never use commands requiring operator privileges.
- Prefer safe walking.
- If asked to "follow me", "come to me", "stay with me", etc., "me" means ${CONFIG.owner}.
- If asked what inventory contains, use inventory.
- If asked where the bot is, use position.
- If an instruction is unclear, use say and ask for clarification.
- Keep chat replies short.
- You may use information from BOT STATE.
`;

  const prompt = `
${systemPrompt}

BOT STATE:
${JSON.stringify(botState())}

PLAYER:
${username}

MESSAGE:
${text}
`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=` +
    encodeURIComponent(CONFIG.geminiKey);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini ${response.status}: ${body}`);
  }

  const data = await response.json();

  const output =
    data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("") || "";

  if (!output) {
    throw new Error("Gemini returned no text");
  }

  return JSON.parse(output);
}

async function executeAction(action) {
  if (!bot?.entity) return;

  switch (action.action) {
    case "say": {
      if (action.message) {
        bot.chat(String(action.message).slice(0, 220));
      }
      break;
    }

    case "stop": {
      stopFollowing();
      bot.chat("Stopped.");
      break;
    }

    case "position": {
      const p = bot.entity.position;

      bot.chat(
        `I'm at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}.`
      );
      break;
    }

    case "inventory": {
      const items = inventorySummary();

      if (!items.length) {
        bot.chat("My inventory is empty.");
        return;
      }

      const text = items
        .map(i => `${i.count}x ${i.displayName}`)
        .join(", ");

      bot.chat(text.slice(0, 240));
      break;
    }

    case "look_player": {
      const player = bot.players[action.player]?.entity;

      if (!player) {
        bot.chat(`I can't see ${action.player}.`);
        return;
      }

      await bot.lookAt(player.position.offset(0, 1.6, 0), true);
      break;
    }

    case "look_position": {
      await bot.lookAt(
        {
          x: Number(action.x),
          y: Number(action.y),
          z: Number(action.z)
        },
        true
      );
      break;
    }

    case "come": {
      const player = bot.players[action.player]?.entity;

      if (!player) {
        bot.chat(`I can't see ${action.player}.`);
        return;
      }

      stopFollowing();

      const p = player.position;

      lastDestination = {
        x: p.x,
        y: p.y,
        z: p.z
      };

      await bot.pathfinder.goto(
        new goals.GoalNear(p.x, p.y, p.z, 2)
      );

      break;
    }

    case "follow": {
      const playerName = action.player || CONFIG.owner;

      if (!bot.players[playerName]?.entity) {
        bot.chat(`I can't see ${playerName}.`);
        return;
      }

      stopFollowing();

      const distance = Math.max(
        1,
        Math.min(6, Number(action.distance || 2))
      );

      const refreshGoal = () => {
        const entity = bot?.players?.[playerName]?.entity;

        if (!entity || !bot?.entity) {
          stopFollowing();
          return;
        }

        const p = entity.position;

        bot.pathfinder.setGoal(
          new goals.GoalNear(p.x, p.y, p.z, distance),
          false
        );
      };

      refreshGoal();

      followTimer = setInterval(refreshGoal, 750);

      bot.chat(`Following ${playerName}.`);

      break;
    }

    case "move": {
      stopFollowing();

      const x = Number(action.x);
      const y = Number(action.y);
      const z = Number(action.z);

      const radius = Math.max(
        1,
        Math.min(5, Number(action.radius || 1))
      );

      if (![x, y, z].every(Number.isFinite)) {
        bot.chat("Those coordinates don't look valid.");
        return;
      }

      lastDestination = { x, y, z };

      bot.chat(
        `Going to ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}.`
      );

      await bot.pathfinder.goto(
        new goals.GoalNear(x, y, z, radius)
      );

      bot.chat("I'm there.");

      break;
    }

    default:
      bot.chat("I didn't understand what action to perform.");
  }
}

async function processInstruction(username, text) {
  if (processing) {
    bot.chat("One second, I'm still doing the previous request.");
    return;
  }

  processing = true;

  try {
    log("Instruction:", username, text);

    const result = await askGemini(username, text);

    log("Gemini:", JSON.stringify(result));

    const actions = Array.isArray(result.actions)
      ? result.actions
      : [result];

    for (const action of actions) {
      if (!action || !action.action) continue;

      await executeAction(action);
    }
  } catch (error) {
    log("AI error:", error);

    if (bot?.entity) {
      bot.chat("I had trouble understanding that.");
    }
  } finally {
    processing = false;
  }
}

function connect() {
  if (bot) return;

  log(
    `Connecting ${CONFIG.username} to ${CONFIG.host}:${CONFIG.port}`
  );

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: "offline",
    version: CONFIG.version,
    hideErrors: false
  });

  bot.loadPlugin(pathfinder);

  bot.once("spawn", () => {
    log("Bot spawned.");

    const movements = new Movements(bot);

    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.maxDropDown = 2;

    bot.pathfinder.setMovements(movements);

    bot.chat("AI bot online.");
  });

  bot.on("chat", async (username, message) => {
    if (username === bot.username) return;

    if (!CONFIG.owner) {
      log("OWNER_USERNAME is not configured.");
      return;
    }

    if (username !== CONFIG.owner) {
      return;
    }

    const text = message.trim();

    if (!text.toLowerCase().startsWith("bot ")) {
      return;
    }

    const instruction = text.slice(4).trim();

    if (!instruction) return;

    await processInstruction(username, instruction);
  });

  bot.on("kicked", reason => {
    log("Kicked:", reason);
  });

  bot.on("error", error => {
    log("Minecraft error:", error);
  });

  bot.on("end", reason => {
    log("Disconnected:", reason);

    stopFollowing();

    bot = null;

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(connect, 30000);
  });
}

process.on("uncaughtException", err => {
  log("Uncaught exception:", err);
});

process.on("unhandledRejection", err => {
  log("Unhandled rejection:", err);
});

connect();