import { User as DiscordOAuthUser } from 'discord-oauth2'

export type ip = string;
export type serverStatus = 'online' | 'offline' | 'deprecated' | 'unknown';
export type serverRegion = 'NA' | 'EU' | 'ASIA' | 'SA' | 'AU' | 'UNKNOWN';

/** Interface representing cooldowns for each IP address */
export interface cooldowns {
    [key: ip]: number;
}

/** Represents a successful authentication */
export interface authSuccess {
    username: string;
    authToken: string;
    premium: number;
    usernameColor?: string;
}

/** Represents a successful authkey response */
export interface authKeySuccess {
    authkey: string;
}

/** Represents a successful key validation */
export interface keyValidationSuccess {
    username: string;
    color?: string;
    velanID?: number;
}

/** Represents an error sent to the client. */
export interface authError {
    type: string;
    message: string;
}

/** Interface representing a collection of authentication codes. */
export interface codes { [key: number]: code; }

/** Represents a stored authentication code. */
export interface code {
    token: string;
    user: DiscordOAuthUser;
    created: number;
}

/** Interface representing a collection of keys. */
export interface keys { [key: string]: key; }

/** Represents a key. */
export interface key {
    id: bigint;
    username: string;
    authToken: string;
    server: ip;
    created: number;
    color?: string;
}

/** Represents a server. */
export interface server {
    id: number;
    status: serverStatus;
    name: string;
    ip: ip;
    region: serverRegion;
    players: number;
    maxPlayers: number;
    owner: number;
}

/** Represents a server from the database. */
export interface dbServer {
    id: number;
    status: serverStatus;
    name: string;
    ip: ip;
    region: serverRegion;
    maxPlayers?: number;
    owner: number;
}

/** Represents user stats of a user. */
export interface userStats {
    id: number;
    username: string;
    registeredat: Date;
    lastlogin: Date;
    ownedServers: server[]
}
    