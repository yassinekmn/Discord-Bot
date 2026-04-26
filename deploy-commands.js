require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('abs')
    .setDescription('WA7EL ABS')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('absskip')
    .setDescription('Skips to the next song in the playlist')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('absstop')
    .setDescription('Stops and disconnects the bot')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('getget')
    .setDescription('GETGET')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('playabs')
    .setDescription('Wa7el ghnaya ya 7azga')
    .addStringOption(option => option.setName('url').setDescription('YouTube URL').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('absqueue')
    .setDescription('Shows the current queue')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log('Registering /abs command...');
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('Done! /abs is registered.');
})(); 
