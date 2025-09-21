import { randomBytes } from "crypto";
import * as types from "./types";
import { User as DiscordOAuthUser } from "discord-oauth2"
import axios from "axios";

import { codes, keys, servers, prisma } from "./index";

/**
 * Generates a random 6 digit code consisting of numbers only.
 * If the generated code already exists in the `codes` object, it will recursively generate a new code up to 10 times.
 * @param {number} i - The number of times the function has recursively generated a new code.
 * @returns {number|null} - The generated code or null if it was unable to generate a unique code after 10 attempts.
 */
export function generateCode(i?: number): number | null {
    if (!i) i = 0;
    if (i > 10) return null;
    let code = Math.floor(Math.random() * 900000) + 100000;
    if (codes[code]) return generateCode(i + 1);
    return code;
}

/**
 * Generates a random 16 character key consisting of numbers and letters.
 * If the generated key already exists in the `keys` object, it will recursively generate a new key up to 10 times.
 * @param {number} i - The number of times the function has recursively generated a new key.
 * @returns {string|null} - The generated key or null if it was unable to generate a unique key after 10 attempts.
 */
export function generateKey(i?: number): string | null {
    if (!i) i = 0;
    // Generate a random 8 digit hex key
    if (i > 10) return null;
    let key = randomBytes(8).toString('hex');
    if (keys[key]) return generateKey(i + 1);
    return key;
}



/**
 * Checks if a given username is valid for registration.
 * @param {string} username - The username to check.
 * @param {DiscordOAuthUser} user - The DiscordOAuthUser object of the user trying to register.
 * @param {any} res - The response object to send an error message to if the username is invalid.
 * @returns {boolean} - True if the username is valid, false otherwise.
 */
export function checkUsername(username: string, user: DiscordOAuthUser, res: any): boolean {
    if (username.length > 16) {
        console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to register with username ${username} but it was too long`);
        res.status(400).send({
            type: "username_too_long",
            message: "Username has to be shorter than 16 characters"
        } as types.authError);
        return false;
    }

    if (username.length < 3) {
        console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to register with username ${username} but it was too short`);
        res.status(400).send({
            type: "username_too_short",
            message: "Username has to be longer than 3 characters"
        } as types.authError);
        return false;
    }

    // the username may only contain letters, numbers, dashes and underscores
    if (!username.match(/^[a-zA-Z0-9-_]+$/)) {
        console.log(`User ${user.username}#${user.discriminator} (${user.id}) tried to register with username ${username} but it was invalid`);
        res.status(400).send({
            type: "invalid_username",
            message: "Username may only contain letters, numbers, dashes and underscores"
        });
        return false;
    }

    return true;
}

/**
 * Checks the status of all servers in the `prisma.servers` database table and updates the `servers` array with the current status, player count and maximum player count of each server.
 * If a server is not found in the `servers` array, it will be added with a status of "offline" and 0 players and maximum players.
 * If a server is found but is offline, it will remain offline.
 * If a server is found but is online, it will be updated with the current player count and maximum player count.
 * If a server is not found in the `prisma.servers` table, it will be ignored.
 * @returns {Promise<void>} - A Promise that resolves when all servers have been checked and updated.
 */
export async function checkServers(): Promise<void> {
    let listServers = await prisma.servers.findMany({ orderBy: { id: 'asc' } })

    const newServers = new Map<number, types.server>();

    for (let rawServer of listServers) {
        if (!rawServer) continue;
        let server = rawServer as any as types.server;

        server.players = 0;
        server.maxPlayers = 0;


        let status = await axios.get(`http://${server.ip}/stats/status`, {
            timeout: 2000,
        }).catch(() => null);


        if (status?.data.connections !== undefined && status?.data.maxConnections !== undefined) {
            server.players = status.data.connections;
            server.maxPlayers = status.data.maxConnections;
        }

        if (status?.data.version !== "3.2.0" && status?.data.status === "OK") server.status = "deprecated";
        else if (status?.data.status === "OK") server.status = "online";
        else server.status = "offline";

        newServers.set(server.id, server);
    }

    const newServersArray: types.server[] = Array.from(newServers.values());

    // sort the servers by id
    newServersArray.sort((a, b) => a.id - b.id);

    servers.list = newServersArray;

    await prisma.$transaction(
        servers.list.map((server: types.server) => {
            return prisma.servers.update({
                where: { id: server.id },
                data: {
                    status: server.status,
                    maxplayers: server.maxPlayers
                }
            });
        })
    );
}