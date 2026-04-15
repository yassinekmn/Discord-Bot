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

const YTDLP = process.platform === 'win32'
  ? 'C:\\Users\\PC\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe'
  : '/usr/local/bin/yt-dlp';

const COOKIES = process.platform === 'win32' ? 'cookies.txt' : '/app/cookies.txt';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EXTRA_ARGS = [
  '--no-check-certificate',
  '--cookies', COOKIES,
  '--extractor-args', 'youtube:skip=hls,dash',
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
      ...EXTRA_ARGS,
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
      ...EXTRA_ARGS,
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

  const ytdlp = spawn(YTDLP, [
    '-f', 'best[ext=mp4]/best',
    '--no-playlist',
    '--extractor-retries', '3',
    '--socket-timeout', '30',
    ...EXTRA_ARGS,
    '-o', '-',
    videoUrl
  ]);

  ytdlp.stderr.on('data', (chunk) => console.error('yt-dlp stderr:', chunk.toString()));
  ytdlp.on('error', (err) => console.error('yt-dlp error:', err));
  ytdlp.on('close', (code) => {
    if (code !== 0) console.error('yt-dlp exited with code', code);
  });

  const resource = createAudioResource(ytdlp.stdout, {
    inputType: StreamType.Arbitrary,
  });

  player = createAudioPlayer();
  player.play(resource);
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
        console.error('Error playing next:', e);
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
          connection = null;
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