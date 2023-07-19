import express from 'express';
import fs from 'fs';
import axios from 'axios';
import crypto from 'crypto';
import DiscordOauth2 from 'discord-oauth2';
import { PrismaClient } from '@prisma/client'
import * as types from './types';
require('dotenv').config();

const oauth = new DiscordOauth2({
    clientId: process.env.CLIENTID,
    clientSecret: process.env.CLIENTSECRET,
    redirectUri: process.env.REDIRECTURI
});

const prisma = new PrismaClient()

const pages = {
    successPage: fs.readFileSync('./www/success.html', 'utf8'),
    deniedPage: fs.readFileSync('./www/denied.html', 'utf8')
}

const app = express();
app.use(express.json());

let codes: types.codes = {};
let keys: types.keys = {};
let servers: types.server[] = [];
let cooldowns: types.cooldowns = {};
export { codes, keys, servers, prisma };

import * as functions from './functions';

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

    // Get the IP address of the user.
    const ip: types.ip = (req.headers['x-forwarded-for'] as string) || (req.socket.remoteAddress as string);

    // check if the IP address is in the cooldowns list.
    if(cooldowns[ip]) cooldowns[ip]++;
    else cooldowns[ip] = 1;

    // If the IP address has been used more than SPAMCUTOFF times, deny the request.
    if(cooldowns[ip] > parseInt(process.env.SPAMCUTOFF as string)) {
        console.log(`Blocked IP ${ip} for making too many requests`);
        return res.status(429).send({
            type: "too_many_requests",
            message: "You have made too many requests, please try again later"
        } as types.authError);
    }

    next();
});

setInterval(() => {
    cooldowns = {};
}, 1000 * 10);

app.get('/', async (req, res) => {
    const { code, error_description } = req.query;
    if(!code) {
        if(!req.query.error_description) return res.status(400).send(pages.deniedPage.replace("%LOGIN_ERROR%", "An unexpected error occured"))
        return res.status(400).send(pages.deniedPage.replace("%LOGIN_ERROR%", (error_description as string).replace("+", " ")));
    }

    const token = await oauth.tokenRequest({
        code: code as string,
        scope: "identify",
        grantType: "authorization_code",
    }).catch(() => {
        return res.redirect('/web/discord')
    });
    if(!token?.access_token) return

    const user = await oauth.getUser(token.access_token).catch(() => {
        return res.redirect('/web/discord')
    });
    if(!user) return

    const loginCode = functions.generateCode();
    if(!loginCode) return res.status(500).send(pages.deniedPage.replace("%LOGIN_ERROR%", "There was an error generating a login code, please try again later"));

    codes[loginCode] = {
        token: token.access_token,
        user: user,
        created: Date.now()
    }

    console.log(`User ${user.username}#${user.discriminator} (${user.id}) generated loginCode ${loginCode}`);

    return res.send(pages.successPage.replace("%LOGIN_CODE%", loginCode.toString()));
});

app.post('/auth/login/', async (req, res) => {
    const { code } = req.body;

    if(!code) return res.status(400).send({
        type: "no_code",
        message: "No code was provided"
    } as types.authError);
    if(!codes[parseInt(code as string)]) return res.status(400).send({
        type: "invalid_code",
        message: "The code provided is invalid"
    } as types.authError);

    const { token, user } = codes[parseInt(code as string)];

    const localUser = await prisma.users.findFirst({
        where: {
            id: BigInt(user.id)
        }
    });

    if (!localUser) {
        console.log(`User ${user.username}#${user.discriminator} (${user.id}) logged in for the first time, sending register header`);
        return res.status(400).send({
            type: "no_account_found",
            message: "No account was found for this user"
        } as types.authError);
    }

    if(localUser.id !== BigInt(user.id)) return res.status(400).send({
        type: "invalid_account",
        message: "The code provided was invalid"
    } as types.authError), console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to login but the code was invalid`);

    if(localUser.banned) return res.status(403).send({
        type: "terminated_account",
        message: "This account has been terminated"
    } as types.authError), console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to login but they were banned`);

    if(!localUser.authtoken || !localUser.tokencreated || Date.now() - Date.parse(localUser.tokencreated.toString()) > 1000 * 60 * 60 * 24 * 7) {
        localUser.authtoken = crypto.randomBytes(16).toString('hex');
        await prisma.users.update({
            where: {
                id: localUser.id
            },
            data: {
                authtoken: localUser.authtoken,
                tokencreated: new Date(),
                lastlogin: new Date()
            }
        });
    } else {
        await prisma.users.update({
            where: {
                id: localUser.id
            },
            data: {
                lastlogin: new Date()
            }
        });
    }

    console.log(`User ${user.username}#${user.discriminator} (${user.id}) logged in`);

    delete codes[parseInt(code as string)];

    return res.send({
        username: localUser.username,
        authToken: localUser.authtoken
    } as types.authSuccess);
});

app.post('/auth/register/', async (req, res) => {
    const { code, username } = req.body;

    if(!code) return res.status(400).send({
        type: "no_code",
        message: "No code was provided"
    } as types.authError);
    if(!codes[parseInt(code as string)]) return res.status(400).send({
        type: "invalid_code",
        message: "The code provided is invalid"
    } as types.authError);

    const { user } = codes[parseInt(code as string)];

    const localUser = await prisma.users.findFirst({
        where: { id: BigInt(user.id) }
    });

    if (localUser) {
        console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to register but already exists`);
        return res.status(409).send({
            type: "account_exists",
            message: "An account already exists for this user"
        } as types.authError);
    }

    if(functions.checkUsername(username, codes[parseInt(code as string)].user, res)) return;

    if(await prisma.users.findFirst({
        where: { username: username } 
    })) return res.status(409).send({
        type: "username_taken",
        message: "This username is already taken"
    } as types.authError);

    let authToken = crypto.randomBytes(16).toString('hex');
    await prisma.users.create({
        data: {
            id: BigInt(user.id),
            username: username,
            registeredat: new Date(),
            lastlogin: new Date(),
            authtoken: authToken,
            tokencreated: new Date()
        }
    });

    console.log(`User ${user.username}#${user.discriminator} (${user.id}) registered with username ${username}`);

    delete codes[parseInt(code as string)];

    return res.send({
        username: username,
        authToken: authToken
    } as types.authSuccess);
});

app.post('/auth/getkey/', async (req, res) => {
    const { username, authToken, server } = req.body;

    if(!username || !authToken || !server) return res.status(400).send({
        type: "missing_data",
        message: "Missing username or auth token or server"
    } as types.authError);

    console.log(`User ${username} is requesting a key for server ${server}`);

    const localUser = await prisma.users.findFirst({
        where: { username: username }
    });

    if(!localUser) return res.status(400).send({
        type: "no_user",
        message: "User does not exist"
    } as types.authError);

    if(localUser.authtoken !== authToken) return res.status(403).send({
        type: "invalid_token",
        message: "Invalid auth token, try relogging in the settings tab"
    } as types.authError);

    if(localUser.banned) return res.status(403).send({
        type: "terminated_account",
        message: "This account has been terminated"
    } as types.authError), console.log(`User ${localUser.username} tried to login but they were banned`);

    let authkey = functions.generateKey();
    if(!authkey || typeof authkey !== "string") return res.status(500).send({  
        type: "internal_error",
        message: "Something went wrong while trying to generate the auth key"
    } as types.authError);

    setTimeout(() => {
        keys[authkey as string] = {
            username: localUser.username,
            authToken: localUser.authtoken as string,
            server: server,
            created: Date.now()
        }

        console.log(`User ${localUser.username} generated a key for server ${server}`);

        return res.send({
            authkey: authkey
        } as types.authKeySuccess);
    }, 1000);
});

app.post('/auth/validate/', async (req, res) => {
    const { authkey, server } = req.body;

    if(!authkey || !server) return res.status(400).send({
        type: "missing_data",
        message: "Missing auth key or server"
    } as types.authError);

    console.log(`A user ${server} is trying to authenticate`);

    let keyData = keys[authkey as string];

    if(!keyData) return res.status(403).send({
        type: "invalid_key",
        message: "The auth key provided is invalid"
    } as types.authError);

    if(keyData.server !== server) return res.status(403).send({
        type: "invalid_server",
        message: "The server ip does not match the one used to generate the key"
    } as types.authError);

    delete keys[authkey as string];
    console.log(`User ${keyData.username} authenticated on server ${server}`);

    return res.send({
        username: keyData.username,
    } as types.keyValidationSuccess);
});

app.get('/web/discord/', (req, res) => {
    console.log(`Redirecting user to discord`);
    res.redirect(oauth.generateAuthUrl({
        scope: ['identify']
    }))
})

app.get('/stats/servers/', (req, res) => {
    console.log(`User requested server stats`);
    res.send(servers.map((server: types.server) => {
        return {
            id: server.id,
            status: server.status,
            name: server.name,
            ip: server.ip,
            region: server.region,
            players: server.status == 'online' && server.players ? server.players : 0,
            maxPlayers: server.status == 'online' && server.maxPlayers ? server.maxPlayers : 0
        }
    }));
})

app.get('/stats/user/id/:id', async (req, res) => {
    const { id } = req.params;

    if(!id) return res.status(400).send({
        type: "invalid_account",
        message: "Missing user id"
    } as types.authError);

    let user = await prisma.users.findFirst({
        where: { id: BigInt(id) },
        select: {
            id: true,
            username: true,
            registeredat: true,
            lastlogin: true
        }
    });
    if(!user) return res.status(400).send({
        type: "invalid_account",
        message: "User does not exist"
    } as types.authError);

    console.log(`User requested stats for user ${user.username} (${user.id})`);

    const ownedServers = await prisma.servers.findMany({
        where: { owner: BigInt(id) },
        select: {
            id: true,
            status: true,
            name: true,
            ip: true,
            region: true,
            owner: true
        }
    });

    return res.send({
        ...user,
        ownedServers: ownedServers.map((server: any) => {
            server.players = server.status == 'online' ? servers.find((x: types.server) => x.id == server.id)?.players || 0 : 0;
            server.maxPlayers = server.status == 'online' ? servers.find((x: types.server) => x.id == server.id)?.maxPlayers || 0 : 0;
            return server;
        })
    } as unknown as types.userStats);
})

app.get("/stats/user/username/:username", async (req, res) => {
    const { username } = req.params;

    if(!username) return res.status(400).send({
        type: "invalid_account",
        message: "No username was provided"
    } as types.authError);

    let user = await prisma.users.findFirst({
        where: { username: username },
        select: {
            id: true,
            username: true,
            registeredat: true,
            lastlogin: true
        }
    });

    if(!user) return res.status(400).send({
        type: "invalid_account",
        message: "User does not exist"
    } as types.authError);

    console.log(`User requested stats for user ${user.username} (${user.id})`);

    const ownedServers = await prisma.servers.findMany({
        where: { owner: user.id },
        select: {
            id: true,
            status: true,
            name: true,
            ip: true,
            region: true,
            owner: true
        }
    });

    return res.send({
        ...user,
        ownedServers: ownedServers.map((server: any) => {
            server.players = server.status == 'online' ? servers.find((x: types.server) => x.id == server.id)?.players || 0 : 0;
            server.maxPlayers = server.status == 'online' ? servers.find((x: types.server) => x.id == server.id)?.maxPlayers || 0 : 0;
            return server;
        })
    } as unknown as types.userStats);
})

// clear codes and keys every 10 minutes
setInterval(() => {
    for (let code in codes) {
        if (Date.now() - codes[code].created > 1000 * 60 * 5) delete codes[code];
    }

    for (let key in keys) {
        if (Date.now() - keys[key].created > 1000 * 60 * 5) delete keys[key];
    }
}, 1000 * 60 * 10);

setInterval(functions.checkServers, 1000 * 30);
functions.checkServers();

app.listen(process.env.PORT || 23501, () => console.log(`AuthServer started on port ${process.env.PORT || '23501'}!`));

process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.log(err);
})