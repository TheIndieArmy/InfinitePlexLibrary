import express, { Request, Response } from "express";
import axios from "axios";
import path from "path";
import dotenv from "dotenv";
import {
    addMovieToRadarr,
    checkMovieInRadarr,
    getMovieStatus,
    isMovieDownloading,
    searchMovieInRadarr
} from "./systems/radarr";
import { config } from "./config";
import {
    notifyPlexFolderRefresh,
    updatePlexDescription
} from "./systems/plex";
import {
    cleanUpDummyFile,
    createDummyFile,
    createSymlink,
    ensureDirectoryExists,
    removeDummyFolder
} from "./utils";
import { terminateStreamByFile } from "./systems/tautulli";
import {
    getEpisodesBySeriesId,
    groupEpisodesBySeason,
    searchSeriesInSonarr,
    getSeriesByTvdbId,
    monitorAllSeasons,
    monitorSeries
} from "./systems/sonarr";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

const DEBUG_MODE = true;

function debugLog(message: string) {
    if (DEBUG_MODE) {
        console.log(`🐛 [DEBUG] ${message}`);
    }
}

// Function to monitor movie availability
async function monitorAvailability(movieId: number, ratingKey: string, originalFilePath: string, movieDescription: string) {
    debugLog(`Monitoring availability for movie ID ${movieId}...`);

    const maxRetries = 60;
    let attempts = 0;

    return new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
            attempts++;

            const movie = await getMovieStatus(movieId);
            const downloading = await isMovieDownloading(movieId);

            if (downloading) {
                debugLog(`Movie ID ${movieId} is currently downloading. Waiting for completion...`);
            }

            if (movie && movie.hasFile && movie.movieFile?.relativePath !== "dummy.mp4") {
                debugLog(`🎉 Movie is now available!`);
                await terminateStreamByFile(originalFilePath);
                clearInterval(interval);
                resolve();
            }

            if (attempts >= maxRetries) {
                debugLog(`⏰ Time limit exceeded. Movie is not available yet.`);
                clearInterval(interval);
                resolve();
            }
        }, 5000); // Check every 5 seconds
    });
}

// Function to monitor season availability
async function monitorSeasonAvailability(seriesId: number, seasonNumber: number, ratingKey: string, seasonDescription: string) {
    debugLog(`Monitoring availability for Season ${seasonNumber} of Series ID ${seriesId}...`);

    const maxRetries = 60;
    let attempts = 0;

    return new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
            attempts++;

            const episodes = await getEpisodesBySeriesId(seriesId, seasonNumber);
            const unavailableEpisodes = episodes.filter((ep: any) => !ep.hasFile || (ep.episodeFile && ep.episodeFile.relativePath === "dummy.mp4"));

            if (unavailableEpisodes.length === 0) {
                debugLog(`🎉 All episodes for Season ${seasonNumber} are now available!`);
                clearInterval(interval);
                resolve();
            } else {
                debugLog(`Waiting for ${unavailableEpisodes.length} episodes to be available...`);
                await updatePlexDescription(ratingKey, seasonDescription, `Waiting for ${unavailableEpisodes.length} episodes...`);
            }

            if (attempts >= maxRetries) {
                debugLog(`⏰ Time limit exceeded. Not all episodes are available yet.`);
                clearInterval(interval);
                resolve();
            }
        }, 5000); // Check every 5 seconds
    });
}

// Handle all events dynamically
async function handleEvent(event: any) {
    debugLog(`Handling event: ${JSON.stringify(event, null, 2)}`);

    switch (event.eventType) {
        case "MovieAdded":
            const movie = event.movie;
            const movieFolder = movie.folderPath;
            const movieFolderDummy = path.join(config.MOVIE_FOLDER_DUMMY, path.basename(movieFolder));
            const plexFolder = path.join(config.PLEX_MOVIE_FOLDER, path.basename(movieFolder));

            debugLog(`Processing MovieAdded event: ${movie.title}`);
            await ensureDirectoryExists(movieFolderDummy);

            const dummyLink = path.join(movieFolderDummy, "dummy.mp4");
            await createDummyFile(config.DUMMY_FILE_LOCATION, dummyLink);
            await createSymlink(dummyLink, plexFolder);

            await notifyPlexFolderRefresh(movieFolder, config.PLEX_MOVIES_LIBRARY_ID);
            break;

        case "Download":
            if (event.movie) {
                const movie = event.movie;
                const movieFolder = movie.folderPath;
                const movieFolderDummy = path.join(config.MOVIE_FOLDER_DUMMY, path.basename(movieFolder));

                debugLog(`Processing Download event for movie: ${movie.title}`);
                await cleanUpDummyFile(movieFolder);
                await removeDummyFolder(movieFolderDummy);

                if (config.RADARR_4K_URL) {
                    const [exists, movieDetails] = await checkMovieInRadarr(
                        movie.tmdbId,
                        config.RADARR_4K_URL,
                        config.RADARR_4K_API_KEY
                    );

                    if (exists && (!movieDetails.hasFile || movieDetails.movieFile?.relativePath === "dummy.mp4")) {
                        debugLog("Movie not available in 4K instance. Initiating search...");
                        await searchMovieInRadarr(movieDetails.id, config.RADARR_4K_URL, config.RADARR_4K_API_KEY);
                    } else if (!exists) {
                        debugLog("Movie not found in 4K instance. Adding movie...");
                        await addMovieToRadarr(
                            movie.tmdbId,
                            config.RADARR_4K_MOVIE_FOLDER,
                            Number(config.RADARR_4K_QUALITY_PROFILE_ID),
                            true,
                            true,
                            config.RADARR_4K_URL,
                            config.RADARR_4K_API_KEY,
                            ["infiniteplexlibrary"]
                        );
                    }
                }

                await notifyPlexFolderRefresh(movieFolder, config.PLEX_MOVIES_LIBRARY_ID);
            } else if (event.series) {
                const series = event.series;
                const episode = event.episodes[0];
                const seasonNumber = episode.seasonNumber;
                const seriesFolder = series.path;
                const dummySeasonFolder = path.join(config.SERIES_FOLDER_DUMMY, path.basename(seriesFolder), `Season ${seasonNumber}`);

                debugLog(`Processing Download event for series: ${series.title}, Season ${seasonNumber}`);
                await cleanUpDummyFile(dummySeasonFolder);
                await removeDummyFolder(dummySeasonFolder);

                await notifyPlexFolderRefresh(seriesFolder, config.PLEX_SERIES_LIBRARY_ID);
            }
            break;

        case "Grab":
            if (event.movie) {
                debugLog(`Grabbed movie: ${event.movie.title} (Release: ${event.release.title})`);
            } else if (event.series) {
                debugLog(`Grabbed episode: ${event.series.title} (Season ${event.episodes[0].seasonNumber}, Episode ${event.episodes[0].episodeNumber})`);
            }
            break;

        case "Rename":
            if (event.movie) {
                debugLog(`Renamed movie: ${event.movie.title}`);
            } else if (event.series) {
                debugLog(`Renamed series: ${event.series.title}`);
            }
            break;

        case "MovieDelete":
            debugLog(`Deleted movie: ${event.movie.title}`);
            break;

        case "SeriesDelete":
            debugLog(`Deleted series: ${event.series.title}`);
            break;

        case "HealthIssue":
            debugLog(`Health issue detected: ${event.message}`);
            break;

        case "Test":
            debugLog("Test webhook received:", event.message);
            break;

        default:
            debugLog(`Unhandled event type: ${event.eventType}`);
    }
}

// Radarr webhook endpoint
app.post("/radarr-webhook", async (req: Request, res: Response) => {
    const event = req.body;

    debugLog("Radarr Webhook received:");
    debugLog(JSON.stringify(event, null, 2));

    if (!event || !event.eventType) {
        debugLog("No valid event received.");
        return res.status(400).send("Invalid event: missing eventType.");
    }

    try {
        await handleEvent(event);
        res.status(200).send("Webhook processed successfully.");
    } catch (error: any) {
        debugLog(`Error processing ${event.eventType} event: ${error.message}`);
        res.status(500).send("Internal Server Error");
    }
});

// Sonarr webhook endpoint
app.post("/sonarr-webhook", async (req: Request, res: Response) => {
    const event = req.body;

    debugLog("Sonarr Webhook received:");
    debugLog(JSON.stringify(event, null, 2));

    if (!event || !event.eventType) {
        debugLog("No valid event received.");
        return res.status(400).send("Invalid event: missing eventType.");
    }

    try {
        await handleEvent(event);
        res.status(200).send("Webhook processed successfully.");
    } catch (error: any) {
        debugLog(`Error processing ${event.eventType} event: ${error.message}`);
        res.status(500).send("Internal Server Error");
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Webhook server is listening on port ${PORT}`);
});
