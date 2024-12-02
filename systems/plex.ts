import axios from "axios";
import { config } from "../config";

export async function notifyPlexFolderRefresh(folderPath: string): Promise<void> {
    try {
        console.log(`🔄 Starting Plex folder scan for folder: ${folderPath}`);

        const url = `${config.PLEX_URL}/library/sections/${config.PLEX_LIBRARY_ID}/refresh?X-Plex-Token=${config.PLEX_TOKEN}&path=${encodeURIComponent(
            folderPath
        )}`;
        const response = await axios.get(url);

        if (response.status === 200) {
            console.log(`✅ Plex folder scan started for folder: ${folderPath}`);
        } else {
            console.error(`❌ Error starting Plex folder scan: Status ${response.status}`);
        }
    } catch (error) {
        console.error("❌ Error communicating with the Plex API:", error);
    }
}


export async function updatePlexDescription(ratingKey: string, movieDescription: string, newDescription: string): Promise<void> {
    try {

        var currentDate = new Intl.DateTimeFormat("nl-NL", { dateStyle: "short", timeStyle: "short" }).format(new Date());
        const combinedDescription = `[${currentDate}]: ${newDescription}\n${movieDescription}`;

        const url = `${config.PLEX_URL}/library/metadata/${ratingKey}?summary.value=${encodeURIComponent(combinedDescription)}&X-Plex-Token=${config.PLEX_TOKEN}`; // Don't know if this is the official way but the webclient does it like this
        const response = await axios.put(url);

        console.log(`✅ Description successfully updated for Plex ID ${ratingKey}.`, response.data);

        // Refresh metadata
        //await refreshPlexMetadata(ratingKey);
    } catch (error: any) {
        console.error(`❌ Error updating the description for Plex ID ${ratingKey}:`, error.message);
    }
}

export async function refreshPlexMetadata(ratingKey: string): Promise<void> {
    try {
        // Plex API endpoint for refreshing metadata
        const refreshUrl = `${config.PLEX_URL}/library/metadata/${ratingKey}/refresh?X-Plex-Token=${config.PLEX_TOKEN}`;

        // Send the POST request to refresh metadata
        await axios.put(refreshUrl);
        console.log(`✅ Metadata successfully refreshed for Plex ID ${ratingKey}.`);
    } catch (error: any) {
        console.error(`❌ Error refreshing metadata for Plex ID ${ratingKey}:`, error.message);
    }
}