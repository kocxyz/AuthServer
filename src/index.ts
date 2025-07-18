import express from 'express';
import fs from 'fs';
import axios from 'axios';
import crypto from 'crypto';
import DiscordOauth2 from 'discord-oauth2';
import { PrismaClient } from '@prisma/client'
import * as types from './types';
import * as Sentry from "@sentry/node"
require('dotenv').config();

Sentry.init({
  dsn: "https://80e91c20dd83ad6d8e6d59109d43d9d7@sentry.ipmake.dev/4",

  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
});

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

    // var fullPath = req.baseUrl + req.path;
    // if(fullPath == "/auth/validate/") return next();

    // // Get the IP address of the user.
    // const ip: types.ip = (req.headers['x-forwarded-for'] as string) || (req.socket.remoteAddress as string);

    // // check if the IP address is in the cooldowns list.
    // if(cooldowns[ip]) cooldowns[ip]++;
    // else cooldowns[ip] = 1;

    // // If the IP address has been used more than SPAMCUTOFF times, deny the request.
    // if(cooldowns[ip] > parseInt(process.env.SPAMCUTOFF as string)) {
    //     console.log(`Blocked IP ${ip} for making too many requests`);
    //     return res.status(429).send({
    //         type: "too_many_requests",
    //         message: "You have made too many requests, please try again later"
    //     } satisfies types.authError);
    // }

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
        authToken: localUser.authtoken,
        premium: localUser.premium,
        usernameColor: localUser.premium === 3 ? (localUser.color || undefined) : undefined
    } satisfies types.authSuccess);
});

app.post('/auth/register/', async (req, res) => {
    const { code, username } = req.body;

    if(!code) return res.status(400).send({
        type: "no_code",
        message: "No code was provided"
    } satisfies types.authError);
    if(!codes[parseInt(code as string)]) return res.status(400).send({
        type: "invalid_code",
        message: "The code provided is invalid"
    } satisfies types.authError);

    const { user } = codes[parseInt(code as string)];

    const localUser = await prisma.users.findFirst({
        where: { id: BigInt(user.id) }
    });

    if (localUser) {
        console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to register but already exists`);
        return res.status(409).send({
            type: "account_exists",
            message: "An account already exists for this user"
        } satisfies types.authError);
    }

    if(!functions.checkUsername(username, codes[parseInt(code as string)].user, res)) return console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to register with username ${username} but it was invalid`)

    if(await prisma.users.findFirst({
        where: { username: username } 
    })) return res.status(409).send({
        type: "username_taken",
        message: "This username is already taken"
    } satisfies types.authError);

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
        authToken: authToken,
        premium: 0
    } satisfies types.authSuccess);
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
            id: localUser.id,
            username: localUser.username,
            authToken: localUser.authtoken as string,
            server: server,
            created: Date.now(),
            color: localUser.premium === 3 ? (localUser.color || undefined) : undefined
        }

        console.log(`User ${localUser.username} generated a key for server ${server}`);

        return res.send({
            authkey: authkey
        } as types.authKeySuccess);
    }, 1000);
});

app.post('/auth/validate/', async (req, res) => {
    const { authkey, server } = req.body as {
        authkey: string,
        server: string,
        keepKey?: boolean
    };

    if(!authkey || !server) return res.status(400).send({
        type: "missing_data",
        message: "Missing auth key or server"
    } satisfies types.authError);

    console.log(`A user ${server} is trying to authenticate`);

    let keyData = keys[authkey as string];

    if(!keyData) return res.status(403).send({
        type: "invalid_key",
        message: "The auth key provided is invalid"
    } satisfies types.authError);

    if(keyData.server !== server) return res.status(403).send({
        type: "invalid_server",
        message: "The server ip does not match the one used to generate the key"
    } satisfies types.authError);

    const serverData = servers.find((x: types.server) => x.ip == keyData.server);
    if(!serverData) {
        res.status(400).send({
            type: "invalid_server",
            message: "The server is not part of the server list"
        } satisfies types.authError);

        return console.log(`User ${keyData.username} authenticated on server ${server} but the server was not found`);
    }

    const userConnected = await prisma.user_on_server.findFirst({
        where: {
            serverID: serverData.id,
            userID: BigInt(keyData.id)
        }
    });

    if(userConnected) delete keys[authkey as string];
    console.log(`User ${keyData.username} authenticated on server ${server}`);
    
    return res.send({
        username: keyData.username,
        color: keyData.color,
        velanID: Number(userConnected?.velanID)
    } satisfies types.keyValidationSuccess);
});

app.post('/auth/connect' , async (req, res) => {
    const { authkey, server, velanID } = req.body as {
        authkey: string,
        server: string,
        velanID: string
    };
    if(!authkey || !server || !velanID) return res.status(400).send({
        type: "missing_data",
        message: "Missing authkey or velanID"
    } satisfies types.authError);
    
    let keyData = keys[authkey as string];

    if(!keyData) return res.status(403).send({
        type: "invalid_key",
        message: "The auth key provided is invalid"
    } satisfies types.authError);

    if(keyData.server !== server) return res.status(403).send({
        type: "invalid_server",
        message: "The server ip does not match the one used to generate the key"
    } satisfies types.authError);

    const serverData = servers.find((x: types.server) => x.ip == keyData.server);
    if(!serverData) {
        res.status(400).send({
            type: "invalid_server",
            message: "The server is not part of the server list"
        } satisfies types.authError);

        return console.log(`User ${keyData.username} authenticated on server ${server} but the server was not found`);
    }

    await prisma.user_on_server.upsert({
        create: {
            serverID: serverData.id,
            velanID: BigInt(velanID),
            userID: BigInt(keyData.id)
        }, 
        update: {},
        where: {
            serverID_userID_velanID: {
                serverID: serverData.id,
                velanID: BigInt(velanID),
                userID: BigInt(keyData.id)
            }
        }
    });

    console.log(`User ${keyData.username} connected to server ${server}`);
    return res.send('OK');
});

app.get('/web/discord/', (req, res) => {
    console.log(`Redirecting user to discord`);
    res.redirect(oauth.generateAuthUrl({
        scope: ['identify']
    }))
})

app.get('/stats/servers/', (req, res) => {
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
    } satisfies types.authError);

    let user = await prisma.users.findFirst({
        where: { id: BigInt(id) },
        select: {
            id: true,
            username: true,
            registeredat: true,
            lastlogin: true,
            premium: true,
            color: true,
            playtime: true
        }
    });
    if(!user) return res.status(400).send({
        type: "invalid_account",
        message: "User does not exist"
    } satisfies types.authError);

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
        user: {
            id: user.id.toString(),
            username: user.username,
            registeredat: user.registeredat,
            lastlogin: user.lastlogin,
            premium: user.premium,
            color: user.premium === 3 ? (user.color || undefined) : undefined,
            playtime: user.playtime
        },
        ownedServers: ownedServers.map((server: any) => {
            server.owner = server.owner.toString();
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
            lastlogin: true,
            premium: true,
            color: true,
            playtime: true
        }
    });

    if(!user) return res.status(400).send({
        type: "invalid_account",
        message: "User does not exist"
    } as types.authError);

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

    // convert BigInt to string


    return res.send({
        user: {
            id: user.id.toString(),
            username: user.username,
            registeredat: user.registeredat,
            lastlogin: user.lastlogin,
            premium: user.premium,
            color: user.premium === 3 ? (user.color || undefined) : undefined,
            playtime: user.playtime
        },
        ownedServers: ownedServers.map((server: any) => {
            server.owner = server.owner.toString();
            server.players = server.status == 'online' ? servers.find((x: types.server) => x.id == server.id)?.players || 0 : 0;
            server.maxPlayers = server.status == 'online' ? servers.find((x: types.server) => x.id == server.id)?.maxPlayers || 0 : 0;
            return server;
        })
    } as unknown as types.userStats);
})

const colors = [
    null,
    '#B80000',
    '#DB3E00',
    '#FCCB00',
    '#008B02',
    '#006B76',
    '#1273DE',
    '#004DCF',
    '#5300EB',
    '#E638bb',
  
    '#49313e',
    '#2e7b15',
    '#33eebd',
    '#55fed4',
    '#81a7f6',
    '#f7a9e7',
    '#860ae9',
    '#f3b17d'
]

app.post("/stats/user/username/:username/setColor", async (req, res) => {
    try {
        const { username } = req.params;
        const { color, token } = req.body;
    
        if(!username || color === undefined || !token) return res.status(400).send({
            type: "invalid_account",
            message: "No credentials or color was provided"
        } as types.authError);
    
        let user = await prisma.users.findFirst({
            where: { username: username },
            select: {
                id: true,
                authtoken: true,
                username: true,
                registeredat: true,
                lastlogin: true,
                premium: true
            }
        });
    
        if(!user) return res.status(400).send({
            type: "invalid_account",
            message: "User does not exist"
        } as types.authError);

        if(user.authtoken !== token) return res.status(403).send({
            type: "invalid_token",
            message: "Invalid auth token, try relogging in the settings tab"
        } as types.authError);
    
        if(user.premium !== 3) return res.status(403).send({
            type: "not_premium",
            message: "Sorry, this feature is only available to patrons"
        } as types.authError);
    
        if(parseInt(color) > colors.length || parseInt(color) < 0) return res.status(400).send({
            type: "invalid_color",
            message: "Invalid color"
        } as types.authError);
    
        await prisma.users.update({
            where: {
                id: user.id
            },
            data: {
                color: colors[parseInt(color)]
            }
        });
    
        return res.send({
            username: user.username,
            color: colors[parseInt(color)]
        });
    } catch (error) {
        console.log(error);
        return res.status(500).send({
            type: "internal_error",
            message: "Something went wrong while trying to set the color"
        } as types.authError);
     }
});

const playtimeCooldowns: Map<string, number> = new Map();

app.post("/stats/user/username/:username/playtime", async (req, res) => {
    try {
        const { username } = req.params;
        const token = req.headers.authorization?.split(' ')[1];
    
        if(!username || !token) return res.status(400).send({
            type: "invalid_account",
            message: "No credentials were provided"
        } as types.authError);
    
        let user = await prisma.users.findFirst({
            where: { username: username },
            select: {
                id: true,
                authtoken: true,
                username: true,
                registeredat: true,
                lastlogin: true,
                premium: true,
            }
        });
    
        if(!user) return res.status(400).send({
            type: "invalid_account",
            message: "User does not exist"
        } as types.authError);

        if(user.authtoken !== token) return res.status(403).send({
            type: "invalid_token",
            message: "Invalid auth token, try relogging in the settings tab"
        } as types.authError);

        if(playtimeCooldowns.has(username) && (Date.now() - (playtimeCooldowns.get(username) ?? 0)) < 1000 * 55) return res.status(429).send({
            type: "cooldown",
            message: "Playtime requests are only allowed once per minute"
        } as types.authError);

        playtimeCooldowns.set(username, Date.now());

        await prisma.users.update({
            where: {
                id: user.id
            },
            data: {
                playtime: {
                    increment: 1
                }
            }
        });
    
        return res.send('OK');
    } catch (error) {
        console.log(error);
        return res.status(500).send({
            type: "internal_error",
            message: "Something went wrong while trying to set playtime"
        } as types.authError);
     }
});

Sentry.setupExpressErrorHandler(app);

// clear codes and keys every 10 minutes
setInterval(() => {
    for (let code in codes) {
        if (Date.now() - codes[code].created > 1000 * 60 * 5) delete codes[code];
    }

    for (let key in keys) {
        if (Date.now() - keys[key].created > 1000 * 60 * 5) delete keys[key];
    }
}, 1000 * 60 * 10);

// Clear the playtime cooldowns every 24 hours
setInterval(() => {
    playtimeCooldowns.clear();
}, 1000 * 60 * 60 * 24);

setInterval(functions.checkServers, 1000 * 30);
functions.checkServers();

app.listen(process.env.PORT || 23501, () => console.log(`AuthServer started on port ${process.env.PORT || '23501'}!`));

process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.log(err);
})