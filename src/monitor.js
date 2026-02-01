import { chromium } from "playwright"

import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_CHAT_ID_2,
  CITY,
  STREET,
  HOUSE,
  SHUTDOWNS_PAGE,
} from "./constants.js"

import {
  capitalize,
  deleteLastMessage,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
} from "./helpers.js"

// Визначаємо CHAT_IDs: з параметрів командного рядка або з констант
const CHAT_IDS = []

// Перший CHAT_ID з параметра або з констант
if (process.argv[2]) {
  CHAT_IDS.push(process.argv[2])
} else if (TELEGRAM_CHAT_ID) {
  CHAT_IDS.push(TELEGRAM_CHAT_ID)
}

// Другий CHAT_ID з параметра (якщо передано) або з констант
if (process.argv[3]) {
  CHAT_IDS.push(process.argv[3])
} else if (TELEGRAM_CHAT_ID_2) {
  CHAT_IDS.push(TELEGRAM_CHAT_ID_2)
}

if (CHAT_IDS.length === 0) {
  throw new Error("❌ Не передано TELEGRAM_CHAT_ID! Додайте в .env або передайте як параметр")
}

console.log(`📱 Відправка в ${CHAT_IDS.length} чат(и): ${CHAT_IDS.join(", ")}`)


async function getInfo() {
  console.log("🌀 Getting info...")

  const browser = await chromium.launch({ headless: true })
  const browserPage = await browser.newPage()

  try {
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const csrfTokenTag = await browserPage.waitForSelector(
      'meta[name="csrf-token"]',
      { state: "attached" }
    )
    const csrfToken = await csrfTokenTag.getAttribute("content")

    const info = await browserPage.evaluate(
      async ({ CITY, STREET, csrfToken }) => {
        const formData = new URLSearchParams()
        formData.append("method", "getHomeNum")
        formData.append("data[0][name]", "city")
        formData.append("data[0][value]", CITY)
        formData.append("data[1][name]", "street")
        formData.append("data[1][value]", STREET)
        formData.append("data[2][name]", "updateFact")
        formData.append("data[2][value]", new Date().toLocaleString("uk-UA"))

        const response = await fetch("/ua/ajax", {
          method: "POST",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "x-csrf-token": csrfToken,
          },
          body: formData,
        })
        return await response.json()
      },
      { CITY, STREET, csrfToken }
    )

    console.log("✅ Getting info finished.")
    return info
  } catch (error) {
    throw Error(`❌ Getting info failed: ${error.message}`)
  } finally {
    await browser.close()
  }
}

function parseScheduleIntervals(response, scheduleId = "GPV5.1") {
  if (!response || !response.fact || !response.fact.today) {
    return [];
  }
  const todayKey = String(response.fact.today);
  const dayData = response.fact.data && response.fact.data[todayKey];
  if (!dayData || !dayData[scheduleId]) {
    return [];
  }

  const hourMap = dayData[scheduleId]; // keys "1".."24"
  // 48 півгодинних слотів, починаючи з 00:00
  const slots = new Array(48).fill("on"); // values: 'on'|'off'|'possible'|'unknown'

  const markHalf = (hourIndex, half, value) => {
    // hourIndex 1..24, half 0|1
    const slotIndex = (hourIndex - 1) * 2 + half;
    slots[slotIndex] = value;
  };

  const mapValueToSlots = (hourIndex, val) => {
    switch ((val || "").toString()) {
      case "no":
        markHalf(hourIndex, 0, "off");
        markHalf(hourIndex, 1, "off");
        break;
      case "yes":
        markHalf(hourIndex, 0, "on");
        markHalf(hourIndex, 1, "on");
        break;
      case "first":
        markHalf(hourIndex, 0, "off");
        markHalf(hourIndex, 1, "on");
        break;
      case "second":
        markHalf(hourIndex, 0, "on");
        markHalf(hourIndex, 1, "off");
        break;
      case "maybe":
        markHalf(hourIndex, 0, "possible");
        markHalf(hourIndex, 1, "possible");
        break;
      case "mfirst":
        markHalf(hourIndex, 0, "possible");
        markHalf(hourIndex, 1, "on");
        break;
      case "msecond":
        markHalf(hourIndex, 0, "on");
        markHalf(hourIndex, 1, "possible");
        break;
      default:
        markHalf(hourIndex, 0, "unknown");
        markHalf(hourIndex, 1, "unknown");
    }
  };

  for (let h = 1; h <= 24; h++) {
    const val = hourMap[String(h)];
    mapValueToSlots(h, val);
  }

  // Функція для форматування слота у час "HH:MM"
  const fmt = (slotIndex) => {
    if (slotIndex < 0) slotIndex = 0;
    if (slotIndex > 48) slotIndex = 48;
    const hour = Math.floor(slotIndex / 2);
    const minute = slotIndex % 2 === 0 ? "00" : "30";
    return `${String(hour).padStart(2, "0")}:${minute}`;
  };

  // Збираємо інтервали для 'off'
  const intervals = [];
  let i = 0;
  while (i < 48) {
    if (slots[i] === "off") {
      let start = i;
      let j = i + 1;
      while (j < 48 && slots[j] === "off") j++;
      intervals.push({ start: fmt(start), end: fmt(j), type: "off" });
      i = j;
      continue;
    }
    i++;
  }

  // Також додаємо 'possible' інтервали
  i = 0;
  while (i < 48) {
    if (slots[i] === "possible") {
      let start = i;
      let j = i + 1;
      while (j < 48 && slots[j] === "possible") j++;
      intervals.push({ start: fmt(start), end: fmt(j), type: "possible" });
      i = j;
      continue;
    }
    i++;
  }

  // Сортуємо інтервали по часу початку
  intervals.sort((a, b) => (a.start > b.start ? 1 : a.start < b.start ? -1 : 0));
  return intervals;
}

function formatScheduleIntervals(intervals, hasData = true, isToday = true) {
  if (!hasData) {
    return "⏳ Дані на наступний день будуть доступні пізніше"
  }

  if (!intervals || intervals.length === 0) {
    if (isToday) {
      return "✅ Відключень не заплановано"
    } else {
      return "⏳ Дані поки що недоступні"
    }
  }

  const offIntervals = intervals.filter(i => i.type === "off")
  const possibleIntervals = intervals.filter(i => i.type === "possible")

  let result = ""

  if (offIntervals.length > 0) {
    result += offIntervals.map(i => `🪫 ${i.start} — ${i.end}`).join("\n")
  }

  if (possibleIntervals.length > 0) {
    if (result) result += "\n"
    result += possibleIntervals.map(i => `❓ ${i.start} — ${i.end} (можливо)`).join("\n")
  }

  if (!result) {
    if (isToday) {
      return "✅ Відключень не заплановано"
    } else {
      return "⏳ Дані поки що недоступні"
    }
  }

  return result
}

function parseFactualOutages(info, house) {
  // Парсимо фактичні відключення з поля 'fact'
  const fact = info?.fact?.data || {}
  const outages = []

  // fact містить timestamp як ключ, в кожному timestamp об'єкт з чергами
  // Для тепер повертаємо порожній масив (структуру понадобиться обговорити)

  return outages
}

function formatFactualOutages(outages) {
  if (!outages || outages.length === 0) {
    return "✅ Фактичних відключень немає"
  }

  return outages
    .slice(0, 5) // Показуємо останні 5
    .map(outage => {
      const icon = outage.type.toLowerCase().includes("аварійне") ? "⚠️" :
        outage.type.toLowerCase().includes("гарантоване") ? "🪫" :
          "📅"
      return `${icon} <b>${outage.date}</b> ${outage.from} — ${outage.to}\n   <i>${outage.type}</i>`
    })
    .join("\n")
}

function getQueueFromGraph(info) {
  const houseData = info?.data?.[HOUSE]
  if (!houseData?.sub_type_reason || houseData.sub_type_reason.length === 0) {
    return "Невідомо"
  }
  return houseData.sub_type_reason.join(", ")
}

function getCurrentPowerStatus(intervals) {
  // Отримуємо поточний час в Києві
  const now = new Date()
  const kyivTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }))
  const currentMinutes = kyivTime.getHours() * 60 + kyivTime.getMinutes()

  // Конвертуємо час "HH:MM" в хвилини
  const timeToMinutes = (timeStr) => {
    const [hours, minutes] = timeStr.split(":").map(Number)
    return hours * 60 + minutes
  }

  // Форматуємо різницю в хвилинах в "X год. YY хв."
  const formatTimeDiff = (diffMinutes) => {
    const hours = Math.floor(diffMinutes / 60)
    const minutes = diffMinutes % 60
    return `${hours} год. ${String(minutes).padStart(2, "0")} хв.`
  }

  // Фільтруємо тільки інтервали відключень (off)
  const offIntervals = intervals.filter(i => i.type === "off")

  if (offIntervals.length === 0) {
    return {
      hasPower: true,
      statusText: "🟢 <b>ЕЛЕКТРИКА Є</b>",
      nextEventText: "✅ Відключень не заплановано"
    }
  }

  // Перевіряємо чи зараз є відключення
  for (const interval of offIntervals) {
    const startMinutes = timeToMinutes(interval.start)
    let endMinutes = timeToMinutes(interval.end)

    // Обробка випадку коли end = "24:00" (кінець дня)
    if (endMinutes === 0 && interval.end === "24:00") {
      endMinutes = 24 * 60
    }

    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      // Зараз відключення - рахуємо час до включення
      const minutesUntilOn = endMinutes - currentMinutes
      return {
        hasPower: false,
        statusText: "🔴 <b>ЕЛЕКТРИКИ НЕМАЄ</b>",
        nextEventText: `⏱ Буде увімкнено через: ${formatTimeDiff(minutesUntilOn)}`
      }
    }
  }

  // Електрика є - шукаємо наступне відключення
  let nextOffMinutes = null
  for (const interval of offIntervals) {
    const startMinutes = timeToMinutes(interval.start)
    if (startMinutes > currentMinutes) {
      if (nextOffMinutes === null || startMinutes < nextOffMinutes) {
        nextOffMinutes = startMinutes
      }
    }
  }

  if (nextOffMinutes !== null) {
    const minutesUntilOff = nextOffMinutes - currentMinutes
    return {
      hasPower: true,
      statusText: "🟢 <b>ЕЛЕКТРИКА Є</b>",
      nextEventText: `⏱ Буде вимкнено через: ${formatTimeDiff(minutesUntilOff)}`
    }
  }

  // Всі відключення на сьогодні вже пройшли
  return {
    hasPower: true,
    statusText: "🟢 <b>ЕЛЕКТРИКА Є</b>",
    nextEventText: "✅ Більше відключень сьогодні не заплановано"
  }
} function generateMessage(info) {
  console.log("🌀 Generating message...")

  if (!info?.data) {
    throw Error("❌ Power outage info missed.")
  }

  const queue = getQueueFromGraph(info)
  const address = `${CITY}, ${STREET}, ${HOUSE}`

  // Парсимо графік відключень для сьогодні
  const todayIntervals = parseScheduleIntervals(info, queue)

  // Парсимо графік для завтра
  const tomorrowKey = info.fact?.today ? String(Number(info.fact.today) + 86400) : null
  const tomorrowData = tomorrowKey && info.fact?.data?.[tomorrowKey]
  const hasTomorrowData = !!tomorrowData

  let tomorrowIntervals = []
  if (hasTomorrowData && tomorrowData[queue]) {
    const tomorrowResponse = {
      fact: {
        today: Number(tomorrowKey),
        data: {
          [tomorrowKey]: { [queue]: tomorrowData[queue] }
        }
      }
    }
    tomorrowIntervals = parseScheduleIntervals(tomorrowResponse, queue)
  }

  const updateTime = getCurrentTime()

  // Форматуємо дати
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, "0")
    const month = String(date.getMonth() + 1).padStart(2, "0")
    return `${day}.${month}`
  }

  const separator = "━"

  let tomorrowText = ""
  if (hasTomorrowData) {
    tomorrowText = formatScheduleIntervals(tomorrowIntervals, true, false)
  } else {
    tomorrowText = "⏳ Графік на завтра ще не доступний (зазвичай з'являється ввечері)"
  }

  // Визначаємо поточний статус електропостачання
  const powerStatus = getCurrentPowerStatus(todayIntervals)

  const message = [
    `⚡️ <b>Статус електропостачання за інформацією ДТЕК</b>`,
    powerStatus.statusText,
    powerStatus.nextEventText,
    separator,
    `🏠 <b>Адреса:</b> ${address}`,
    `🔢 <b>Черга:</b> ${queue}`,
    separator,
    `📅 <b>Графік на сьогодні (${formatDate(today)}):</b>`,
    formatScheduleIntervals(todayIntervals, true, true),
    separator,
    `📅 <b>Графік на завтра (${formatDate(tomorrow)}):</b>`,
    tomorrowText,
    separator,
    `🕐 <i>Оновлено: ${updateTime}</i>`,
  ].join("\n")

  console.log("✉️ Message generated successfully")
  return message
}

async function sendNotification(message) {
  if (!TELEGRAM_BOT_TOKEN)
    throw Error("❌ Missing telegram bot token.")
  if (CHAT_IDS.length === 0)
    throw Error("❌ Missing telegram chat ids.")

  console.log("🌀 Sending notification...")
  console.log("📨 Message length:", message.length)

  for (const chatId of CHAT_IDS) {
    const lastMessage = loadLastMessage(chatId) || {}
    let endpoint = lastMessage.message_id ? "editMessageText" : "sendMessage"
    let url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`

    console.log(`📤 Using endpoint: ${endpoint}`)
    console.log(`💬 Chat ID: ${chatId}`)

    try {
      let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          message_id: lastMessage.message_id ?? undefined,
        }),
      })

      let data = await response.json()

      // Якщо повідомлення не змінилося - це нормально, пропускаємо
      if (!response.ok && data.description?.includes("message is not modified")) {
        console.log(`ℹ️ Повідомлення не змінилося для чату ${chatId}, пропускаємо`)
        continue
      }

      // Якщо editMessageText не знайшло повідомлення - відправляємо нове
      if (!response.ok && data.description?.includes("message to edit not found")) {
        console.log(`⚠️ Message not found, sending new message...`)
        deleteLastMessage(chatId)

        endpoint = "sendMessage"
        url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`

        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
          }),
        })

        data = await response.json()
      }

      if (!response.ok) {
        console.error(`🔴 Telegram API error for chat ${chatId}:`, data)
        throw new Error(`Telegram API error: ${data.description}`)
      }

      if (data.ok && data.result) {
        saveLastMessage(data.result, chatId)
        console.log(`🟢 Notification sent to chat ${chatId}!`)
        console.log("✉️ Message ID:", data.result.message_id)
      } else {
        console.error("🔴 Unexpected response:", data)
        throw new Error("Unexpected Telegram API response")
      }
    } catch (error) {
      console.error(`🔴 Notification not sent to chat ${chatId}:`, error.message)
      deleteLastMessage(chatId)
      throw error
    }
  }
}

async function run() {
  try {
    console.log("🚀 Starting DTEK Monitor...")
    const info = await getInfo()

    console.log("📊 Info received successfully")
    console.log("🔍 Queue:", info.data?.[HOUSE]?.sub_type_reason?.[0] || "Unknown")

    const message = generateMessage(info)
    console.log("✉️ Message generated successfully")

    console.log("\n" + "=".repeat(50))
    console.log("📨 Повідомлення для відправки:")
    console.log("=".repeat(50))
    console.log(message.replace(/<\/?[^>]+(>|$)/g, "")) // Прибираємо HTML теги для консолі
    console.log("=".repeat(50) + "\n")

    await sendNotification(message)
    console.log("✅ Script completed successfully!")
  } catch (error) {
    console.error("❌ Error occurred:", error.message)
    console.error("Stack trace:", error.stack)
    process.exit(1)
  }
}

run().catch((error) => console.error(error.message))
