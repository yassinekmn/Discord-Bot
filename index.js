process.env.OPUS_ENGINE = 'opusscript';
process.env.YTDL_NO_UPDATE = '1';
delete process.env.YTDL_PATH;
require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { spawn } = require('child_process');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let queue = [];
let currentIndex = 0;
let player = null;
let connection = null;
let isPlaying = false;

async function getPlaylistVideos(url) {
  return new Promise((resolve, reject) => {
    const ytList = spawn('C:\\Users\\PC\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe', [
      '--flat-playlist',
      '-j',
      url
    ]);

    let data = '';
    ytList.stdout.on('data', (chunk) => { data += chunk; });
    ytList.on('close', (code) => {
      if (code !== 0) return reject(new Error('Failed to get playlist'));
      const videos = data.trim().split('\n').map(line => JSON.parse(line));
      resolve(videos);
    });
    ytList.on('error', reject);
  });
}

async function playVideo(videoUrl, voiceChannel, interaction, msgReply) {
  if (connection) {
    connection.destroy();
    connection = null;
  }

  if (!voiceChannel) {
    voiceChannel = interaction.member?.voice?.channel;
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
  });

  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      isPlaying = false;
      queue = [];
      currentIndex = 0;
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (e) {
    if (e.code === 'ABORT_ERR') return;
    throw e;
  }

  const ytdlp = spawn('C:\\Users\\PC\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe', [
    '-f', 'bestaudio',
    '-q',
    '-o', '-',
    videoUrl
  ]);

  const resource = createAudioResource(ytdlp.stdout);
  player = createAudioPlayer();

  player.play(resource);
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, async () => {
    currentIndex++;
    if (currentIndex < queue.length) {
      const nextVideo = queue[currentIndex];
      try {
        await playVideo(nextVideo.url, voiceChannel, interaction);
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

  ytdlp.on('error', (err) => console.error('yt-dlp error:', err));
  ytdlp.on('close', (code) => {
    if (code !== 0) console.error('yt-dlp exited with code', code);
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

client.once('ready', () => {
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
  if (!voiceChannel) {
    return interaction.reply({
      content: 'You need to be in a voice channel first!',
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'abs') {
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return interaction.reply({
        content: 'Already playing! Use /absskip to skip.',
        ephemeral: true,
      });
    }

    if (connection) {
      try { connection.destroy(); } catch (e) {}
    }
    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;

    await interaction.deferReply();

    try {
      isPlaying = true;
      const url = process.env.YOUTUBE_URL;
      const isPlaylist = url.includes('&list=');
      
      if (isPlaylist) {
        const videos = await getPlaylistVideos(url);
        queue = videos.map((v, i) => ({ url: v.url, title: v.title }));
        currentIndex = 0;
        console.log(`Playlist loaded: ${queue.length} videos`);
      } else {
        queue = [{ url: url, title: 'Single video' }];
        currentIndex = 0;
      }

      const currentVideo = queue[currentIndex];
      const reply = await interaction.editReply(`Now playing: **${currentVideo.title}** in **${voiceChannel.name}**! 🎵`);
      await playVideo(currentVideo.url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      isPlaying = false;
      await interaction.editReply('Error: ' + err.message);
    }
  }

  if (interaction.commandName === 'absskip') {
    if (!isPlaying || queue.length === 0) {
      return interaction.reply({
        content: 'Nothing is playing!',
        ephemeral: true,
      });
    }

    if (currentIndex >= queue.length - 1) {
      return interaction.reply({
        content: 'No more songs in playlist!',
        ephemeral: true,
      });
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

  if (interaction.commandName === 'absstop') {
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      return interaction.reply({
        content: 'Bot is not in a voice channel!',
        ephemeral: true,
      });
    }

    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection.destroy();
    connection = null;
    await interaction.reply('Bot disconnected! 🛑');
  }

  if (interaction.commandName === 'getget') {
    const url = 'https://www.youtube.com/watch?v=H1W_6ndmctI&list=RDH1W_6ndmctI&start_radio=1';

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed && isPlaying) {
      queue.push({ url: url, title: 'Requested song' });
      return interaction.reply(`Added to queue: **Requested song** (position ${queue.length})`);
    }

    if (connection) {
      try { connection.destroy(); } catch (e) {}
    }
    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;

    await interaction.deferReply();

    try {
      isPlaying = true;
      queue = [{ url: url, title: 'Requested song' }];
      currentIndex = 0;

      const currentVideo = queue[currentIndex];
      const reply = await interaction.editReply(`Now playing: **${currentVideo.title}** in **${voiceChannel.name}**! 🎵`);
      await playVideo(currentVideo.url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      isPlaying = false;
      await interaction.editReply('Error: ' + err.message);
    }
  }

  if (interaction.commandName === 'playabs') {
    const url = interaction.options.getString('url');

    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed && isPlaying) {
      queue.push({ url: url, title: 'Requested song' });
      return interaction.reply(`Added to queue: **Requested song** (position ${queue.length})`);
    }

    if (connection) {
      try { connection.destroy(); } catch (e) {}
    }
    isPlaying = false;
    queue = [];
    currentIndex = 0;
    connection = null;

    await interaction.deferReply();

    try {
      isPlaying = true;
      queue = [{ url: url, title: 'Requested song' }];
      currentIndex = 0;

      const currentVideo = queue[currentIndex];
      const reply = await interaction.editReply(`Now playing: **${currentVideo.title}** in **${voiceChannel.name}**! 🎵`);
      await playVideo(currentVideo.url, voiceChannel, interaction, reply);
    } catch (err) {
      console.error(err);
      isPlaying = false;
      await interaction.editReply('Error: ' + err.message);
    }
  }

  if (interaction.commandName === 'absqueue') {
    if (queue.length === 0) {
      return interaction.reply({ content: 'Queue is empty!' });
    }
    let msg = '**Queue:**\n';
    queue.forEach((v, i) => {
      msg += `${i + 1}. ${v.title}${i === currentIndex ? ' (now playing)' : ''}\n`;
    });
    await interaction.reply(msg);
  }
});

client.login(process.env.DISCORD_TOKEN);