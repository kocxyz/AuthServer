# KoCity.xyz Auth Server

This is the top level authentication server for KOCity.xyz. It is responsible for authenticating users and providing them with a keys and tokens to gatekeep kocity.xyz public servers using the [AuthProxy](https://github.com/kocxyz/AuthProxy)

## DISCLAIMER

This is not an actively supported software. It is only here to disclose the inner workings of the KOCity.xyz project. It is not recommended to use this software in production and does not come with any warranty whatsoever.

## Installation

### Requirements

- A PostgreSQL database
- NodeJS LTS

### Setup

1. Clone the repository
2. Run `npm install`
3. Create a `.env` file in the root directory with the following contents:
```env
# Discord Stuff
CLIENTID="discordAppID"
CLIENTSECRET="discordAppSecret"
REDIRECTURI="http://localhost:23501"

# Database Stuff
DATABASE_URL="postgres://YourUserName:YourPassword@yourhostname:5432/YourDatabaseName"

# Web Stuff
SPAMCUTOFF=5
```
4. Run `npm run db:migrate` to create the database tables
5. Run `npm start` to start the server


## Contributing

Please join the [KOCity.xyz Discord Server](https://kocity.xyz/discord) and contact one of the developers if you want to contribute or feel free to open a pull request.
