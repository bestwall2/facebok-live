/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER
 * Author: You
 * Description:
 * - Fetch streams from API
 * - Create Facebook Live
 * - Start FFmpeg
 * - Wait for ALL streams to be running
 * - Then fetch DASH URLs
 * - Send full Telegram reports
 * - Handle exceptions with delay
 ******************************************************************/

// ================== IMPORTS ==================
import { spawn } from "child_process";
import fs from "fs";

// ================== CONFIG ==================
const CONFIG = {
  apiUrl: "https://ani-box-nine.vercel.app/api/grok-chat",

  pollInterval: 60_000,          // فحص دوري كل دقيقة
  restartDelay: 2 * 60_000,      // ⏳ انتظار دقيقتين بعد أي استثناء
  reportInterval: 5 * 60_000,    // 📊 تقرير Telegram كل 5 دقائق

  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    // دعم متعدد الشات IDs
    chatIds: ["5806630118","6605454954"], // يمكن إضافة المزيد: ["5806630118", "شات_آخر", "شات_ثالث"]
  }
};

// ================== GLOBAL STATE ==================
let allItems = new Map();        // جميع البثوث
let activeStreams = new Map();  // FFmpeg processes
let isRestarting = false;
let startTime = Date.now();

// ================== LOGGER ==================
class Logger {
  static log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync("logs.txt", line + "\n");
  }
  static info(m) { this.log("INFO", m); }
  static warn(m) { this.log("WARN", m); }
  static error(m) { this.log("ERROR", m); }
  static success(m) { this.log("SUCCESS", m); }
}

// ================== TELEGRAM ==================
class Telegram {
  // إرسال إلى جميع الشات IDs
  static async send(text) {
    const sendPromises = CONFIG.telegram.chatIds.map(async (chatId) => {
      const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML"
          })
        });
      } catch (error) {
        Logger.error(`فشل الإرسال إلى ${chatId}: ${error.message}`);
      }
    });
    
    await Promise.all(sendPromises);
  }

  // إرسال تقرير الحالة
  static async sendStatus() {
    const uptime = Math.floor((Date.now() - startTime) / 60000);
    const activeCount = Array.from(allItems.values()).filter(item => 
      activeStreams.has(item.id) && activeStreams.get(item.id).process && !activeStreams.get(item.id).process.killed
    ).length;
    
    const status = `📡 **حالة النظام**\n\n` +
                   `⏱️ وقت التشغيل: ${uptime} دقيقة\n` +
                   `📊 عدد البثوث الكلي: ${allItems.size}\n` +
                   `🟢 البثوث النشطة: ${activeCount}\n` +
                   `🔴 البثوث المعطلة: ${allItems.size - activeCount}\n` +
                   `🔄 آخر تحديث: ${new Date().toLocaleTimeString()}`;
    
    await this.send(status);
  }
}

// ================== FACEBOOK ==================
class FacebookAPI {
  // إنشاء بث Facebook
  static async createLive(token, name) {
    const res = await fetch(
      "https://graph.facebook.com/v24.0/me/live_videos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: name,
          status: "UNPUBLISHED",
          access_token: token
        })
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return {
      id: json.id,
      rtmps: json.secure_stream_url
    };
  }

  // جلب DASH بعد تشغيل FFmpeg
  static async getDash(id, token) {
    const res = await fetch(
      `https://graph.facebook.com/v24.0/${id}?fields=dash_preview_url&access_token=${token}`
    );
    const json = await res.json();
    return json.dash_preview_url;
  }
}

// ================== STREAM MANAGER ==================
class StreamManager {
  static startFFmpeg(item) {
    Logger.info(`Starting FFmpeg: ${item.name}`);

    const ff = spawn("ffmpeg", [
      "-re",
      "-i", item.source,
      "-c", "copy",
      "-f", "flv",
      item.rtmps
    ]);

    activeStreams.set(item.id, {
      process: ff,
      startTime: Date.now(),
      status: "running"
    });

    ff.stderr.on("data", d => {
      const msg = d.toString();
      if (msg.includes("error") || msg.includes("failed")) {
        Logger.error(`FFmpeg error [${item.name}]: ${msg.slice(0, 200)}`);
        ExceptionHandler.trigger(`FFmpeg Error في ${item.name}`);
      }
    });

    ff.on("exit", code => {
      Logger.warn(`FFmpeg exited [${item.name}]: code ${code}`);
      const streamInfo = activeStreams.get(item.id);
      if (streamInfo) {
        streamInfo.status = "stopped";
        streamInfo.exitCode = code;
        streamInfo.stopTime = Date.now();
      }
      ExceptionHandler.trigger(`FFmpeg خرج في ${item.name}`);
    });
  }

  static stopAll() {
    activeStreams.forEach((info, id) => {
      if (info.process && !info.process.killed) {
        info.process.kill("SIGTERM");
      }
    });
    activeStreams.clear();
  }

  static checkAllRunning() {
    return Array.from(allItems.values()).every(item => 
      activeStreams.has(item.id) && 
      activeStreams.get(item.id).status === "running"
    );
  }
}

// ================== EXCEPTION HANDLER ==================
class ExceptionHandler {
  static async trigger(reason) {
    if (isRestarting) return;
    isRestarting = true;

    Logger.warn(`Exception: ${reason}`);
    await Telegram.send(`⚠️ استثناء مكتشف\n${reason}\n⏳ إعادة التشغيل خلال دقيقتين`);

    setTimeout(async () => {
      await Main.restart();
      isRestarting = false;
    }, CONFIG.restartDelay);
  }
}

// ================== ITEMS COMPARATOR ==================
class ItemsComparator {
  // مقارنة العناصر القديمة بالجديدة لاكتشاف التغيرات
  static hasChanges(oldItems, newItems) {
    if (oldItems.size !== newItems.size) {
      Logger.info(`تغير في العدد: ${oldItems.size} → ${newItems.size}`);
      return true;
    }

    // مقارنة كل عنصر
    for (const [id, oldItem] of oldItems) {
      const newItem = newItems.get(id);
      if (!newItem) {
        Logger.info(`عنصر محذوف: ${oldItem.name}`);
        return true;
      }

      // مقارنة الحقول المهمة
      if (oldItem.source !== newItem.source || 
          oldItem.name !== newItem.name || 
          oldItem.token !== newItem.token) {
        Logger.info(`تغير في العنصر: ${oldItem.name}`);
        return true;
      }
    }

    // التحقق من عناصر جديدة
    for (const [id, newItem] of newItems) {
      if (!oldItems.has(id)) {
        Logger.info(`عنصر جديد: ${newItem.name}`);
        return true;
      }
    }

    return false;
  }
}

// ================== POLLING SYSTEM ==================
class PollingSystem {
  static lastItemsHash = "";
  
  // إنشاء بصمة للعناصر لاكتشاف التغيرات
  static createItemsHash(items) {
    const itemsArray = Array.from(items.values())
      .map(item => `${item.source}|${item.name}|${item.token}`)
      .sort()
      .join('||');
    
    return Buffer.from(itemsArray).toString('base64');
  }

  static async pollForChanges() {
    if (isRestarting) {
      Logger.info("تخطي الفحص بسبب إعادة التشغيل");
      return;
    }

    try {
      Logger.info("🔍 فحص دوري للعناصر...");
      const newItems = await Main.fetchItems();
      const newHash = this.createItemsHash(newItems);
      
      if (newHash !== this.lastItemsHash) {
        Logger.info("🔄 تغيير مكتشف! إعادة التشغيل...");
        
        // إرسال إشعار بالتغيير
        const oldCount = allItems.size;
        const newCount = newItems.size;
        await Telegram.send(
          `🔄 **تم اكتشاف تغيير في البثوث**\n\n` +
          `📊 العدد السابق: ${oldCount}\n` +
          `📊 العدد الجديد: ${newCount}\n` +
          `⏳ جاري إعادة التشغيل...`
        );
        
        // إعادة التشغيل
        this.lastItemsHash = newHash;
        ExceptionHandler.trigger("تغيير في العناصر من API");
      } else {
        Logger.info("✅ لا يوجد تغييرات");
      }
    } catch (error) {
      Logger.error(`خطأ في الفحص الدوري: ${error.message}`);
    }
  }
}

// ================== MAIN ==================
class Main {
  // جلب البيانات من API
  static async fetchItems() {
    const res = await fetch(CONFIG.apiUrl);
    const json = await res.json();

    const map = new Map();
    json.data.forEach((it, i) => {
      // إنشاء ID فريد بناءً على المصدر والاسم
      const itemId = `item_${Buffer.from(`${it.source}|${it.name}`).toString('base64').slice(0, 10)}`;
      
      map.set(itemId, {
        id: itemId,
        token: it.token,
        name: it.name,
        source: it.source,
        img: it.img,
        addedTime: Date.now()
      });
    });
    return map;
  }

  // التشغيل الكامل
  static async start() {
    try {
      Logger.info("جلب العناصر...");
      allItems = await this.fetchItems();
      
      if (allItems.size === 0) {
        Logger.warn("لا توجد عناصر في API");
        await Telegram.send("⚠️ **تحذير**: لا توجد بثوث في API");
        return;
      }

      // 1️⃣ إنشاء بثوث Facebook
      const creationPromises = Array.from(allItems.values()).map(async (item) => {
        try {
          const live = await FacebookAPI.createLive(item.token, item.name);
          item.streamId = live.id;
          item.rtmps = live.rtmps;
          Logger.info(`تم إنشاء بث: ${item.name}`);
        } catch (error) {
          Logger.error(`فشل إنشاء بث لـ ${item.name}: ${error.message}`);
          item.failed = true;
        }
      });

      await Promise.all(creationPromises);

      // التحقق من وجود بثوث ناجحة
      const successfulItems = Array.from(allItems.values()).filter(item => !item.failed);
      if (successfulItems.length === 0) {
        throw new Error("فشل إنشاء جميع البثوث");
      }

      // 2️⃣ تشغيل FFmpeg
      successfulItems.forEach(item => {
        StreamManager.startFFmpeg(item);
      });

      // 3️⃣ انتظار حتى يشتغل الجميع
      let attempts = 0;
      const maxAttempts = 30; // 30 * 2 ثانية = 60 ثانية كحد أقصى
      
      while (attempts < maxAttempts) {
        const allRunning = StreamManager.checkAllRunning();
        if (allRunning) break;
        
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
      }

      // 4️⃣ جلب DASH + إرسال تقرير
      let report = `📊 **تقرير البثوث**\n\n`;
      let successCount = 0;
      
      for (const item of successfulItems) {
        try {
          if (activeStreams.get(item.id)?.status === "running") {
            item.dash = await FacebookAPI.getDash(item.streamId, item.token);
            report += `✅ **${item.name}**\n🔗 ${item.dash}\n\n`;
            successCount++;
          } else {
            report += `❌ **${item.name}** (متوقف)\n\n`;
          }
        } catch (error) {
          report += `⚠️ **${item.name}** (خطأ: ${error.message})\n\n`;
        }
      }

      report += `📈 **المجموع**: ${successCount}/${successfulItems.length} بث ناجح`;
      
      await Telegram.send(report);
      Logger.success(`جميع البثوث شغالة: ${successCount}/${allItems.size}`);

      // تحديث بصمة العناصر
      PollingSystem.lastItemsHash = PollingSystem.createItemsHash(allItems);
      
    } catch (error) {
      Logger.error(`خطأ في التشغيل: ${error.message}`);
      throw error;
    }
  }

  static async restart() {
    Logger.warn("إعادة تشغيل النظام...");
    StreamManager.stopAll();
    await this.start();
  }
}

// ================== INTERVALS ==================

// 📊 تقرير الحالة كل 5 دقائق
setInterval(async () => {
  if (!isRestarting) {
    await Telegram.sendStatus();
  }
}, CONFIG.reportInterval);

// 🔍 فحص التغيرات كل دقيقة
setInterval(async () => {
  await PollingSystem.pollForChanges();
}, CONFIG.pollInterval);

// ================== START ==================
Main.start().catch(async (e) => {
  Logger.error(`خطأ بدئي: ${e.message}`);
  await Telegram.send(`🚨 **خطأ بدئي**\n${e.message}\n⏳ إعادة التشغيل خلال دقيقتين`);
  
  setTimeout(async () => {
    try {
      await Main.restart();
    } catch (error) {
      Logger.error(`فشل إعادة التشغيل: ${error.message}`);
    }
  }, CONFIG.restartDelay);
});

// ================== EVENT HANDLERS ==================
process.on('SIGINT', () => {
  Logger.info("تلقي SIGINT، إيقاف جميع البثوث...");
  StreamManager.stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  Logger.info("تلقي SIGTERM، إيقاف جميع البثوث...");
  StreamManager.stopAll();
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  Logger.error(`خطأ غير معالج: ${error.message}`);
  await Telegram.send(`🚨 **خطأ غير معالج**\n${error.message}\n⏳ إعادة التشغيل خلال دقيقتين`);
  ExceptionHandler.trigger("خطأ غير معالج");
});

process.on('unhandledRejection', async (reason, promise) => {
  Logger.error(`رفض غير معالج: ${reason}`);
  await Telegram.send(`🚨 **رفض غير معالج**\n${reason}\n⏳ إعادة التشغيل خلال دقيقتين`);
  ExceptionHandler.trigger("رفض غير معالج");
});
