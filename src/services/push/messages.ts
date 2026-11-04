export const inviteMessage = (projectTitle: string, projectId: string) => ({
  body: `You were invited to “${projectTitle}”`,
  data: { kind: "invite", projectId },
});

export const movieReadyMessage = (montageId: string) => ({
  body: "Your movie is ready",
  data: { kind: "movie_ready", montageId },
});

export const montageFailedMessage = (montageId: string) => ({
  body: "The movie could not be made",
  data: { kind: "montage_failed", montageId },
});
