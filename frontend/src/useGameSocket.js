import { useEffect } from "react";

// Generate a random ID if not present
const getDeviceUserId = () => {
    let id = localStorage.getItem("device_user_id");
    if (!id) {
        id = `usr_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem("device_user_id", id);
    }
    return id;
};

// We create a global hook or state manager for the socket connection
export const useGameSocket = (socket, setGameState) => {
    useEffect(() => {
        if (!socket) return;

        // Auth flow on connect
        socket.on("connect", () => {
            const userId = getDeviceUserId();
            const username = localStorage.getItem("username") || `Player_${userId.substring(4, 8)}`;

            socket.emit("register_user", { userId, username }, (res) => {
                if (res.status === "success") {
                    setGameState(prev => ({ ...prev, user: res.user, isConnected: true }));
                }
            });
        });

        socket.on("disconnect", () => {
            setGameState(prev => ({ ...prev, isConnected: false }));
        });

        socket.on("room_update", (room) => {
            setGameState(prev => ({ ...prev, currentRoom: room }));
        });

        socket.on("friend_added", (friend) => {
            setGameState(prev => {
                if (!prev.user) return prev;
                const isAlreadyFriend = prev.user.friends?.some(f => f.userId === friend.userId);
                if (isAlreadyFriend) return prev;

                // Fire notification only when we are actually adding the friend to state
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('notify_user', { detail: `Demande d'ami reçue de ${friend.username}` }));
                }, 0);

                return {
                    ...prev,
                    user: {
                        ...prev.user,
                        friends: [...(prev.user.friends || []), { userId: friend.userId, username: friend.username, online: true }]
                    }
                };
            });
        });

        socket.on("user_updated", (newData) => {
            setGameState(prev => ({
                ...prev,
                user: { ...prev.user, ...newData }
            }));
        });

        socket.on("game_state_update", (gameStateData) => {
            setGameState(prev => ({
                ...prev,
                currentRoom: { ...prev.currentRoom, gameState: gameStateData }
            }));
        });

        socket.on("timer_tick", ({ timeRemaining }) => {
            setGameState(prev => {
                if (!prev.currentRoom || !prev.currentRoom.gameState) return prev;
                return {
                    ...prev,
                    currentRoom: {
                        ...prev.currentRoom,
                        gameState: { ...prev.currentRoom.gameState, timeRemaining }
                    }
                };
            });
        });

        socket.on("turn_ended", (room) => {
            setGameState(prev => ({ ...prev, currentRoom: room }));
        });

        socket.on("game_invite", (invite) => {
            window.dispatchEvent(new CustomEvent('notify_user', { detail: `${invite.fromUsername} vous a invité dans le salon ${invite.roomId}` }));
            setGameState(prev => {
                if (!prev.user) return prev;
                const isAlreadyInvited = prev.user.pendingInvites?.some(i => i.roomId === invite.roomId && i.fromUserId === invite.fromUserId);
                if (isAlreadyInvited) return prev;

                return {
                    ...prev,
                    user: {
                        ...prev.user,
                        pendingInvites: [...(prev.user.pendingInvites || []), invite]
                    }
                };
            });
        });

        const handleLocalFriendAdd = (e) => {
            const friend = e.detail;
            setGameState(prev => {
                if (!prev.user) return prev;
                const isAlreadyFriend = prev.user.friends?.some(f => f.userId === friend.userId);
                if (isAlreadyFriend) return prev;
                return {
                    ...prev,
                    user: {
                        ...prev.user,
                        friends: [...(prev.user.friends || []), { userId: friend.userId, username: friend.username, online: friend.online }]
                    }
                };
            });
        };
        window.addEventListener('add_friend_local', handleLocalFriendAdd);

        return () => {
            socket.off("connect");
            socket.off("disconnect");
            socket.off("room_update");
            socket.off("friend_added");
            socket.off("user_updated");
            socket.off("game_state_update");
            socket.off("timer_tick");
            socket.off("turn_ended");
            socket.off("game_invite");
            window.removeEventListener('add_friend_local', handleLocalFriendAdd);
        };
    }, [socket, setGameState]);
};
