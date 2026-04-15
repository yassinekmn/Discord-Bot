process.env.OPUS_ENGINE = 'opusscript';
require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YTDLP = process.platform === 'win32'
  ? 'C:\\Users\\PC\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe'
  : '/usr/local/bin/yt-dlp';

// Resolve the cookies file path. If the YOUTUBE_COOKIES env var is set, write
// its contents to a temporary file so yt-dlp can read them. This allows
// Railway users to paste their Netscape-format cookie file into an env var
// without needing to bake it into the Docker image.
function resolveCookiesFile() {
  const envCookies = process.env.YOUTUBE_COOKIES;
  if (envCookies && envCookies.trim()) {
    const tmpPath = path.join(os.tmpdir(), 'yt-dlp-cookies.txt');
    try {
      fs.writeFileSync(tmpPath, envCookies, 'utf8');
      console.log(`[cookies] Wrote YOUTUBE_COOKIES env var to ${tmpPath}`);
      return tmpPath;
    } catch (e) {
      console.error('[cookies] Failed to write YOUTUBE_COOKIES to temp file:', e);
    }
  }
  // Fall back to the bundled cookies.txt if it exists
  const fallback = process.platform === 'win32' ? 'cookies.txt' : '/app/cookies.txt';
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return null;
}

const COOKIES = resolveCookiesFile();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Build the --cookies flag args only when a cookies file is available
const COOKIES_ARGS = COOKIES ? ['--cookies', COOKIES] : [];

// Used for getting title and playlist info (needs cookies, uses web client)
const EXTRA_ARGS_INFO = [
  '--no-check-certificate',
  ...COOKIES_ARGS,
  '--extractor-args', 'youtube:player_client=web',
  '--force-ipv4',
  '--add-header', `User-Agent:${UA}`,
];

// Used for actual playback — also pass cookies when available so authenticated
// requests can bypass bot-detection on restricted videos
const EXTRA_ARGS_PLAY = [
  '--no-check-certificate',
  ...COOKIES_ARGS,
  '--extractor-args', 'youtube:player_client=android_vr',
  '--force-ipv4',
  '--add-header', `User-Agent:${UA}`,
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('error', (err) => console.error('Client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

let queue = [];
let currentIndex = 0;
let player = null;
let connection = null;
let isPlaying = false;

async function getVideoTitle(url) {
  return new Promise((resolve) => {
    const proc = spawn(YTDLP, [
      '--get-title',
      '--no-playlist',
      ...EXTRA_ARGS_INFO,
      url
    ]);
    let title = '';
    proc.stdout.on('data', (chunk) => { title += chunk; });
    proc.stderr.on('data', (chunk) => console.error('yt-dlp title stderr:', chunk.toString()));
    proc.on('close', () => resolve(title.trim() || 'Unknown title'));
    proc.on('error', () => resolve('Unknown title'));
  });
}

async function getPlaylistVideos(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, [
      '--flat-playlist',
      '-j',
      ...EXTRA_ARGS_INFO,
      url
    ]);
    let data = '';
    proc.stdout.on('data', (chunk) => { data += chunk; });
    proc.stderr.on('data', (chunk) => console.error('yt-dlp playlist stderr:', chunk.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('Failed to get playlist'));
      const videos = data.trim().split('\n').map(line => JSON.parse(line));
      resolve(videos.map(v => ({ url: `https://www.youtube.com/watch?v=${v.id}`, title: v.title })));
    });
    proc.on('error', reject);
  });
}

async function playVideo(videoUrl, voiceChannel, interaction, msgReply) {
  if (connection) {
    try { connection.destroy(); } catch (e) {}
    connection = null;
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      isPlaying = false;
      queue = [];
      currentIndex = 0;
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (e) {
    if (e.code === 'ABORT_ERR') return;
    throw e;
  }

  // Spawn yt-dlp and wait for the first chunk of audio data before wiring up
  // the player. This lets us detect bot-detection / download failures early
  // and throw a proper error instead of passing a broken stream to the player.
  const ytdlpStream = await new Promise((resolve, reject) => {
    const ytdlp = spawn(YTDLP, [
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--extractor-retries', '3',
      '--socket-timeout', '30',
      ...EXTRA_ARGS_PLAY,
      '-o', '-',
      videoUrl
    ]);

    let stderrOutput = '';
    let resolved = false;

    ytdlp.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrOutput += text;
      console.error('yt-dlp stderr:', text);
    });

    ytdlp.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`yt-dlp process error: ${err.message}`));
      }
    });

    ytdlp.on('close', (code) => {
      if (code !== 0 && !resolved) {
        resolved = true;
        // Surface a human-readable message for the most common failure
        const botBlocked = /Sign in to confirm|bot detection|not a bot/i.test(stderrOutput);
        const msg = botBlocked
          ? 'YouTube blocked the download (bot detection). Set the YOUTUBE_COOKIES env var with valid cookies to bypass this.'
          : `yt-dlp exited with code ${code}`;
        reject(new Error(msg));
      }
    });

    // Resolve as soon as the first byte of audio arrives so we know the
    // download actually started. The stream is still live at this point.
    ytdlp.stdout.once('data', (chunk) => {
      if (!resolved) {
        resolved = true;
        // Push the chunk back so createAudioResource sees the full stream
        ytdlp.stdout.unshift(chunk);
        resolve(ytdlp.stdout);
      }
    });
  });

  if (!ytdlpStream) {
    throw new Error('yt-dlp returned a null stream — download may have failed silently.');
  }

  const resource = createAudioResource(ytdlpStream, {
    inputType: StreamType.Arbitrary,
  });

  player = createAudioPlayer();
  player.play(resource);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    throw new Error('Voice connection was lost before playback could start.');
  }
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, async () => {
    currentIndex++;
    if (currentIndex < queue.length) {
      const nextVideo = queue[currentIndex];
      try {
        await playVideo(nextVideo.url, voiceChannel, interaction, msgReply);
        if (msgReply && msgReply.channel) {
          await msgReply.edit(`Now playing: **${nextVideo.title}** in **${voiceChannel.name}**! 🎵`);
        }
      } catch (e) {
        console.error('Error playing next video:', e);
        // Notify the user about the failed track and attempt to skip to the one after
        if (msgReply && msgReply.channel) {
          try {
            await msgReply.edit(`⚠️ Failed to play **${nextVideo.title}**: ${e.message} — skipping…`);
          } catch (_) {}
        }
        // Try to advance past the broken track rather than stopping entirely
        currentIndex++;
        if (currentIndex < queue.length) {
          const skipTo = queue[currentIndex];
          try {
            await playVideo(skipTo.url, voiceChannel, interaction, msgReply);
            if (msgReply && msgReply.channel) {
              await msgReply.edit(`Now playing: **${skipTo.title}** in **${voiceChannel.name}**! 🎵`);
            }
          } catch (e2) {
            console.error('Error playing video after skip:', e2);
            if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
              connection.destroy();
              connection = null;
            }
            isPlaying = false;
          }
        } else {
          if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
            connection = null;
          }
          isPlaying = false;
        }
      }
    } else {
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
        connection = null;
      }
      isPlaying = false;
      if (msgReply && msgReply.channel) {
        await msgReply.edit('Playlist ended! 🎶');
      }
    }
  });

  player.on('error', (err) => {
    console.error('Player error:', err);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
      connection = null;
    }
    isPlaying = false;
  });
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.channelId && !newState.channelId && newState.id === client.user.id) {
    console.log('Bot was disconnected from voice channel');
    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const voiceChannel = interaction.member?.voice?.channel;

  const commandsNeedingVoice = ['abs', 'getget', 'playabs', 'absskip'];
  if (commandsNeedingVoice.includes(interaction.commandName) && !voiceChannel) {
    return interaction.reply({
      content: 'You need to be in a voice channel first!',
      ephemeral: true,
    });
  }

  // /abs
  if (interaction.commandName === 'abs') {
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return interaction.reply({ content: 'Already playing! Use /absskip to skip.', ephemeral: true });
    }

    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;

    await interaction.deferReply();

    try {
      isPlaying = true;
      const url = process.env.YOUTUBE_URL;
      const isPlaylist = url.includes('list=');

      if (isPlaylist) {
        const videos = await getPlaylistVideos(url);
        queue = videos;
      } else {
        const title = await getVideoTitle(url);
        queue = [{ url, title }];
      }

      currentIndex = 0;
      const reply = await interaction.editReply(`Now playing: **${queue[0].title}** in **${voiceChannel.name}**! 🎵`);
      await playVideo(queue[0].url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      isPlaying = false;
      await interaction.editReply('Error: ' + err.message);
    }
  }

  // /getget
  if (interaction.commandName === 'getget') {
    const url = 'https://www.youtube.com/watch?v=H1W_6ndmctI';

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed && isPlaying) {
      queue.push({ url, title: 'Requested song' });
      return interaction.reply(`Added to queue (position ${queue.length})`);
    }

    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;

    await interaction.deferReply();

    try {
      isPlaying = true;
      const title = await getVideoTitle(url);
      queue = [{ url, title }];
      currentIndex = 0;

      const reply = await interaction.editReply(`Now playing: **${title}** in **${voiceChannel.name}**! 🎵`);
      await playVideo(url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      isPlaying = false;
      await interaction.editReply('Error: ' + err.message);
    }
  }

  // /playabs
  if (interaction.commandName === 'playabs') {
    const url = interaction.options.getString('url');

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed && isPlaying) {
      const title = await getVideoTitle(url);
      queue.push({ url, title });
      return interaction.reply(`Added to queue: **${title}** (position ${queue.length})`);
    }

    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;

    await interaction.deferReply();

    try {
      isPlaying = true;
      const title = await getVideoTitle(url);
      queue = [{ url, title }];
      currentIndex = 0;

      const reply = await interaction.editReply(`Now playing: **${title}** in **${voiceChannel.name}**! 🎵`);
      await playVideo(url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      isPlaying = false;
      await interaction.editReply('Error: ' + err.message);
    }
  }

  // /absskip
  if (interaction.commandName === 'absskip') {
    if (!isPlaying || queue.length === 0) {
      return interaction.reply({ content: 'Nothing is playing!', ephemeral: true });
    }
    if (currentIndex >= queue.length - 1) {
      return interaction.reply({ content: 'No more songs in queue!', ephemeral: true });
    }

    await interaction.deferReply();
    currentIndex++;
    const nextVideo = queue[currentIndex];

    try {
      const reply = await interaction.editReply(`Skipped! Now playing: **${nextVideo.title}** 🎵`);
      await playVideo(nextVideo.url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      await interaction.editReply('Error skipping: ' + err.message);
    }
  }

  // /absstop
  if (interaction.commandName === 'absstop') {
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      return interaction.reply({ content: 'Bot is not in a voice channel!', ephemeral: true });
    }

    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection.destroy();
    connection = null;
    await interaction.reply('Bot disconnected! 🛑');
  }

  // /absqueue
  if (interaction.commandName === 'absqueue') {
    if (queue.length === 0) {
      return interaction.reply({ content: 'Queue is empty!' });
    }
    let msg = '**Queue:**\n';
    queue.forEach((v, i) => {
      msg += `${i + 1}. ${v.title}${i === currentIndex ? ' ▶️ now playing' : ''}\n`;
    });
    await interaction.reply(msg);
  }
});

client.login(process.env.DISCORD_TOKEN);