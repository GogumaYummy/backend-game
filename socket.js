const http = require('http');
const { Server } = require('socket.io');
const { Op } = require('sequelize');
require('dotenv');
const { Player, Room, Table } = require('./models');
const app = require('./app');
const { eventName } = require('./eventName');

const DB = require('./models');
const cookieParser = require('./utils/cookie-parser');
const CustomError = require('./utils/custom-error');
const verifyToken = require('./utils/verify-token');
const { default: axios } = require('axios');
// db 연결

const server = http.createServer(app);

// 테이블 생성
DB.sequelize
  .sync()
  .then(() => {
    console.log('database 연결 성공');
  })
  .catch(console.error);

const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://frontend-delta-puce.vercel.app'],
    method: ['GET', 'POST'],
    credentials: true,
  },
});

io.on('connection', async (socket) => {
  try {
    const { cookie } = socket.handshake.headers;

    if (!cookie)
      throw new CustomError('요청에 쿠키가 포합되어 있지 않습니다.', 301);

    const { accessToken } = cookieParser(cookie);

    if (!accessToken)
      throw new CustomError('엑세스 토큰이 담긴 쿠키가 없습니다.', 302);

    const { userId } = verifyToken(accessToken);

    if (!userId) throw new CustomError('엑세스 토큰이 유효하지 않습니다.', 303);

    const { data } = await axios.get(
      `${process.env.MAIN_SERVER_URL}/p/users/${userId}`
    );

    console.log(socket.data);

    socket.onAny((event, ...args) => {
      console.log(`들어온 이벤트 이름: ${event}`);
      if (args) {
        console.log('매개변수:');
        args.forEach((arg) => {
          console.log(arg);
        });
      }
    });

    socket.onAnyOutgoing((event, ...args) => {
      console.log(`나가는 이벤트 이름: ${event}`);
      if (args) {
        console.log('매개변수:');
        args.forEach((arg) => {
          console.log(arg);
        });
      }
    });

    socket.on(eventName.SEND_MESSAGE, (msg, room, addMyMessage) => {
      // 소켓 아이디에 맞는 닉네임을 뽑아서 msg와 같이 전송
      const userName = socket.data.userName;

      socket.to(room).emit(eventName.RECEIVE_MESSAGE, msg, userName);
      addMyMessage(msg);
    });

    socket.on(eventName.JOINED, async (roomId, fn) => {
      // TODO:
      // game-info 필요
      // roomId에 따른 방 제목 -> 게임 시작시 상단 바 정보(비공개, 인원, 방제목)
      // room 정보 마지막 함수로
      // userName은 main DB에서 추출

      // TODO: 쿠키에서 받아올 예정
      // const userName = 'hohoho';
      // const userProfileImg = 'https://cdn.davinci-code.online/1675150781053';

      const score = 0;

      const room = await Room.findOne({ where: { roomId } });

      if (!room) {
        // TODO: 방 없을 때 에러 처리
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      // socket.data.userId = userId;
      socket.data.userId = data.userId;
      const userId = data.userId;
      socket.data.userProfileImg = data.profileImageUrl;
      socket.data.userName = data.username;

      // FIXME: 유저 중복으로 joined 안먹는 부분 수정 필요
      // const duplicate = await Player.findOne({ where: { userId } });
      // if (duplicate) {
      //   await Player.destroy({ where: { userId } });
      // }

      console.log('socket.data.userId', socket.data.userId);
      console.log('입력 받은 userId', userId);
      console.log('socket.data.userName', socket.data.userName);

      let table = await room.getTable();

      if (!table) {
        table = await Table.create({
          blackCards: JSON.stringify([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
          ]),
          whiteCards: JSON.stringify([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
          ]),
          users: JSON.stringify([]),
          top: JSON.stringify([]),
          turn: userId,
          roomId,
        });

        await Promise.all([room.setTable(table), table.setRoom(room)]);
      }

      const player = await Player.create({
        userId,
        sids: socket.id,
        userName: socket.data.userName,
        userProfileImg: socket.data.userProfileImg,
        security: '',
        isReady: false,
        gameOver: false,
        hand: JSON.stringify([]),
        score,
      });

      room.addPlayer(player);

      const usersData = JSON.parse(table.users);

      usersData.push({ userId });

      await Table.update(
        { users: JSON.stringify(usersData) },
        { where: { roomId } }
      );

      let tableInfo = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards', 'turn'],
        raw: true,
      });

      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'isReady',
          'gameOver',
          'hand',
          'sids',
          'userProfileImg',
        ],
        raw: true,
      });

      let userInfoV2 = userInfo.map((el) => {
        return {
          userId: el.userId,
          userName: el.userName,
          userProfileImg: el.userProfileImg,
          isReady: el.isReady ? true : false,
          gameOver: el.gameOver ? true : false,
          hand: JSON.parse(el.hand),
        };
      });

      let cardResult = {
        blackCards: JSON.parse(tableInfo.blackCards).length,
        whiteCards: JSON.parse(tableInfo.whiteCards).length,
        turn: tableInfo.turn,
        users: userInfoV2,
      };

      console.log('members 값 확인 console.log', userInfoV2.length);
      // TODO: 보내주기 위한 roomInfo
      const roomInfo = {
        maxMembers: room.maxMembers,
        members: userInfoV2.length,
        isPlaying: room.isPlaying,
        secret: room.password ? true : false,
        roomId: room.roomId,
        roomName: room.roomName,
      };

      userInfo.forEach((el) =>
        socket.to(el.sids).emit(eventName.ADD_READY, cardResult, roomInfo)
      );
      fn(cardResult, roomInfo);
    });

    socket.on(eventName.READY, async () => {
      const roomId = socket.data.roomId;
      const userId = socket.data.userId;

      console.log('roomId"', roomId);
      console.log('userId:', userId);

      const room = await Room.findOne({ where: { roomId } });
      const userReady = await Player.findOne({
        where: { userId, [Op.and]: [{ roomId }] },
        attributes: ['isReady'],
        raw: true,
      });

      userReady.isReady
        ? await Player.update({ isReady: false }, { where: { userId } })
        : await Player.update({ isReady: true }, { where: { userId } });

      let readyCount = await Player.findAll({
        where: {
          roomId,
          [Op.and]: [{ isReady: 1 }],
        },
        attributes: ['isReady'],
        raw: true,
      });

      let tableInfo = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards', 'turn', 'users'],
        raw: true,
      });

      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'isReady',
          'gameOver',
          'hand',
          'sids',
          'userProfileImg',
        ],
        raw: true,
      });

      let userInfoV2 = userInfo.map((el) => {
        return {
          userId: el.userId,
          userName: el.userName,
          userProfileImg: el.userProfileImg,
          isReady: el.isReady ? true : false,
          gameOver: el.gameOver ? true : false,
          hand: JSON.parse(el.hand),
        };
      });

      let cardResult = {
        blackCards: JSON.parse(tableInfo.blackCards).length,
        whiteCards: JSON.parse(tableInfo.whiteCards).length,
        turn: tableInfo.turn,
        users: userInfoV2,
      };

      let roomInfo = {
        maxMembers: room.maxMembers,
        members: userInfoV2.length,
        isPlaying: room.isPlaying,
        secret: room.password ? true : false,
        roomId: room.roomId,
        roomName: room.roomName,
      };

      userInfo.forEach((el) =>
        io.to(el.sids).emit(eventName.ADD_READY, cardResult, roomInfo)
      );

      if (JSON.parse(tableInfo.users).length > 1)
        if (readyCount.length === JSON.parse(tableInfo.users).length) {
          roomInfo.isPlaying = true;
          userInfo.forEach((el) =>
            io.to(el.sids).emit(eventName.GAME_START, roomInfo)
          );
          await Room.update({ isPlaying: true }, { where: { roomId } });
        }
    });

    socket.on(eventName.FIRST_DRAW, async (black, myCard) => {
      const roomId = socket.data.roomId;
      const white = 3 - black;
      const userId = socket.data.userId;
      let getCards = [];

      let cardResult = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards'],
        raw: true,
      });
      let cards = JSON.parse(cardResult.blackCards);

      // black 뽑기
      for (let i = 0; i < black; i++) {
        let cardLength = cards.length;
        let CardIndex = Math.floor(Math.random() * Number(cardLength));
        let randomCard = cards[CardIndex];
        if (randomCard === 12) {
          i--;
          continue;
        }

        getCards = [
          ...getCards,
          { color: 'black', value: Number(randomCard), isOpen: false },
        ];
        cards.splice(CardIndex, 1);
      }

      await Table.update(
        { blackCards: JSON.stringify(cards) },
        { where: { roomId } }
      );

      cards = JSON.parse(cardResult.whiteCards);
      // white 뽑기
      for (let i = 0; i < white; i++) {
        let cardLength = cards.length;
        let CardIndex = Math.floor(Math.random() * Number(cardLength));
        let randomCard = cards[CardIndex];
        if (randomCard === 12) {
          i--;
          continue;
        }
        getCards = [
          ...getCards,
          { color: 'white', value: Number(randomCard), isOpen: false },
        ];
        cards.splice(CardIndex, 1);
      }

      await Table.update(
        { whiteCards: JSON.stringify(cards) },
        { where: { roomId } }
      );

      getCards
        .sort((a, b) => a.value - b.value)
        .sort((a, b) => {
          if (a.value === b.value) {
            if (a.color < b.color) return -1;
            else if (b.color < a.color) return 1;
            else return 0;
          }
        });

      await Player.update(
        { hand: JSON.stringify(getCards) },
        { where: { userId } }
      );

      let tableInfo = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards', 'users', 'turn'],
        raw: true,
      });

      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'gameOver',
          'hand',
          'sids',
          'needToBeDeleted',
          'userProfileImg',
        ],
        raw: true,
      });

      let myInfo = userInfo.map((el) => {
        if (el.userId === userId) {
          return {
            userId: el.userId,
            userName: el.userName,
            userProfileImg: el.userProfileImg,
            gameOver: el.gameOver ? true : false,
            hand: JSON.parse(el.hand).map((card) => {
              console.log('카드 value:', card.value);
              return {
                color: card.color,
                value: card.value,
                isOpen: card.isOpen,
              };
            }),
          };
        } else {
          return {
            userId: el.userId,
            userName: el.userName,
            userProfileImg: el.userProfileImg,
            gameOver: el.gameOver ? true : false,
            hand: JSON.parse(el.hand).map((card) => {
              return {
                color: card.color,
                value: 'Back',
                isOpen: card.isOpen,
              };
            }),
          };
        }
      });

      let mycardResult = {
        blackCards: JSON.parse(tableInfo.blackCards).length,
        whiteCards: JSON.parse(tableInfo.whiteCards).length,
        turn: tableInfo.turn,
        users: myInfo,
      };

      myCard(mycardResult);
      // length 가 0

      const completion = userInfo.filter(
        (el) => JSON.parse(el.hand).length === 0
      ).length;

      if (completion === 0) {
        function info(temp) {
          const gameInfo = userInfo.map((el) => {
            return {
              userId: el.userId,
              userName: el.userName,
              userProfileImg: el.userProfileImg,
              gameOver: el.gameOver ? true : false,
              hand: JSON.parse(el.hand).map((card) => {
                if (el.userId === temp.userId) {
                  return {
                    color: card.color,
                    value: card.value,
                    isOpen: card.isOpen,
                  };
                } else if (!card.isOpen) {
                  return {
                    color: card.color,
                    value: 'Back',
                    isOpen: card.isOpen,
                  };
                } else {
                  return {
                    color: card.color,
                    value: card.value,
                    isOpen: card.isOpen,
                  };
                }
              }),
            };
          });
          cardResult = {
            blackCards: JSON.parse(tableInfo.blackCards).length,
            whiteCards: JSON.parse(tableInfo.whiteCards).length,
            turn: tableInfo.turn,
            users: gameInfo,
          };
          return cardResult;
        }
        userInfo.forEach((el) => {
          if (!el.needToBeDeleted) {
            const result = info(el);
            io.to(el.sids).emit(eventName.DRAW_RESULT, result);
          }
        });
      }
    });

    socket.on(eventName.COLOR_SELECTED, async (color, myCard) => {
      let roomId = socket.data.roomId;
      const userId = socket.data.userId;
      let oneCard = {};
      let cardResult = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards'],
        raw: true,
      });
      if (color === 'black') {
        let cards = JSON.parse(cardResult.blackCards);
        let cardLength = cards.length;
        let cardIndex = Math.floor(Math.random() * Number(cardLength));
        let randomCard = cards[cardIndex];
        myCard({ color: 'black', value: Number(randomCard), isOpen: false });
        await Player.update(
          {
            security: JSON.stringify({
              color: 'black',
              value: Number(randomCard),
            }),
          },
          { where: { userId } }
        );
        oneCard = { color: 'black', value: Number(randomCard), isOpen: false };
        cards.splice(cardIndex, 1);
        await Table.update(
          { blackCards: JSON.stringify(cards) },
          { where: { roomId } }
        );
      } else {
        let cards = JSON.parse(cardResult.whiteCards);
        let cardLength = cards.length;
        let cardIndex = Math.floor(Math.random() * Number(cardLength));
        let randomCard = cards[cardIndex];
        myCard({ color: 'white', value: Number(randomCard), isOpen: false });
        await Player.update(
          {
            security: JSON.stringify({
              color: 'white',
              value: Number(randomCard),
            }),
          },
          { where: { userId } }
        );
        oneCard = { color: 'white', value: Number(randomCard), isOpen: false };
        cards.splice(cardIndex, 1);
        await Table.update(
          { whiteCards: JSON.stringify(cards) },
          { where: { roomId } }
        );
      }
      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'gameOver',
          'hand',
          'sids',
          'needToBeDeleted',
        ],
        raw: true,
      });

      userInfo.forEach((el) => {
        if (!el.needToBeDeleted)
          socket.to(el.sids).emit(eventName.RESULT_SELECT, { userId, color });
      });
    });

    socket.on(eventName.GUESS, async (userId, { index, value }) => {
      const roomId = socket.data.roomId;

      let targetHand = JSON.parse(
        (
          await Player.findOne({
            where: { userId, [Op.and]: [{ roomId }] },
            attributes: ['hand'],
            raw: true,
          })
        ).hand
      );
      console.log('target유저 이전 값:', targetHand);
      let result = false;
      let guessResult = {};
      let userCard;
      let no_security;
      let userInfoV2;

      // HACK: 타겟유저의 카드를 맞췄을 때
      if (targetHand[index].value === value) {
        console.log('result true');
        console.log('타겟의 값', targetHand[index].value);
        console.log('설정한 값', value);
        targetHand[index].isOpen = true;
        if (targetHand.filter((card) => card.isOpen === false).length) {
          await Player.update(
            { hand: JSON.stringify(targetHand) },
            { where: { userId } }
          );
          console.log('1번콘솔', { hand: JSON.stringify(targetHand) });
        } else {
          await Player.update(
            { hand: JSON.stringify(targetHand), gameOver: true },
            { where: { userId } }
          );

          let topRank = JSON.parse(
            (
              await Table.findOne({
                where: { roomId },
                attributes: ['top'],
                raw: true,
              })
            ).top
          );

          let getUser = await Player.findOne({
            where: { userId, [Op.and]: [{ roomId }] },
            attributes: ['userId', 'userName', 'score'],
            raw: true,
          });
          // FIXME 스코어 받아와서 정보 넣어줘야함.
          topRank.unshift(getUser);

          await Table.update(
            { top: JSON.stringify(topRank) },
            { where: { roomId } }
          );

          await Room.update({ isPlaying: false }, { where: { roomId } });

          console.log('2번콘솔');
        }
        console.log(1);
        userCard = await Player.findOne({
          where: { userId, [Op.and]: [{ roomId }] },
          attributes: ['hand', 'security'],
          raw: true,
        });

        result = true;
      } else {
        // 틀렸을 때
        console.log(2);
        console.log('result false');
        console.log('타겟의 값', targetHand[index].value);
        console.log('설정한 값', value);
        userCard = await Player.findOne({
          where: { userId: socket.data.userId, [Op.and]: [{ roomId }] },
          attributes: ['hand', 'security'],
          raw: true,
        });
        console.log(3);
        console.log('test console:: ', userCard);
        let changeHand = JSON.parse(userCard.hand);
        let targetSecurity = JSON.parse(userCard.security);
        console.log('test console::changeHand ', changeHand);
        console.log('test console::targetSecurity ', targetSecurity);

        for (let i = 0; i < changeHand.length; i++) {
          if (
            changeHand[i].value == targetSecurity.value &&
            changeHand[i].color == targetSecurity.color
          ) {
            changeHand[i].isOpen = true;
          }
        }
        console.log(4);
        console.log('changeHand값 :', changeHand);
        console.log('이후에 변한 값 측정 console:', changeHand);

        if (changeHand.filter((card) => card.isOpen === false).length) {
          await Player.update(
            { hand: JSON.stringify(changeHand) },
            { where: { userId: socket.data.userId } }
          );
        } else {
          await Player.update(
            { hand: JSON.stringify(changeHand), gameOver: true, security: '' },
            { where: { userId: socket.data.userId } }
          );

          let topRank = JSON.parse(
            (
              await Table.findOne({
                where: { roomId },
                attributes: ['top'],
                raw: true,
              })
            ).top
          );

          let getUser = await Player.findOne({
            where: { userId: socket.data.userId, [Op.and]: [{ roomId }] },
            attributes: ['userId', 'userName', 'score'],
            raw: true,
          });
          // FIXME 스코어 받아와서 정보 넣어줘야함.
          topRank.unshift(getUser);

          await Table.update(
            { top: JSON.stringify(topRank) },
            { where: { roomId } }
          );
        }

        const table = await Table.findOne({ where: { roomId } });
        let player = await Player.findAll({ where: { roomId } });
        let nextTurn = table.turn;
        let turns = JSON.parse(table.users);

        let turnIndex = 0;

        for (let i = 0; i < turns.length; i++) {
          if (turns[i].userId === nextTurn) {
            turnIndex = i;
            break;
          }
        }

        let flag = 0;

        for (let i = 1; i < turns.length + 1; i++) {
          for (let j = 0; j < player.length; j++) {
            if (
              turns[(turnIndex + i) % turns.length].userId ==
                player[j].userId &&
              !player[j].gameOver
            ) {
              nextTurn = player[j].userId;
              flag = 1;
              break;
            }
          }
          if (flag) {
            break;
          }
        }

        console.log(7);
        await Table.update({ turn: nextTurn }, { where: { roomId } });

        result = false;
      }

      // TODO: 전체적으로 뿌려주기 전에 상태값 다 입히기.
      console.log(8);
      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'isReady',
          'gameOver',
          'hand',
          'sids',
          'userProfileImg',
          'security',
        ],
        raw: true,
      });
      console.log(9);
      let tableInfoV2 = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards', 'turn'],
        raw: true,
      });

      function info(temp) {
        const some = userInfo.map((el) => {
          return {
            userId: el.userId,
            userName: el.userName,
            userProfileImg: el.userProfileImg,
            gameOver: el.gameOver ? true : false,
            hand: JSON.parse(el.hand).map((card) => {
              if (el.userId === temp.userId) {
                return {
                  color: card.color,
                  value: card.value,
                  isOpen: card.isOpen,
                };
              } else if (!card.isOpen) {
                return {
                  color: card.color,
                  value: 'Back',
                  isOpen: card.isOpen,
                };
              } else {
                return {
                  color: card.color,
                  value: card.value,
                  isOpen: card.isOpen,
                };
              }
            }),
          };
        });
        console.log(10);
        (no_security = userCard.security.length === 0 ? false : true),
          (guessResult = {
            blackCards: JSON.parse(tableInfoV2.blackCards).length,
            whiteCards: JSON.parse(tableInfoV2.whiteCards).length,
            turn: tableInfoV2.turn,
            users: some,
          });
        return guessResult;
      }
      console.log(11);

      // gameover 일 때
      if (userInfo.filter((user) => user.gameOver == false).length === 1) {
        console.log(12);
        const winner = await Player.findOne({
          where: {
            roomId,
            [Op.and]: [{ gameOver: false }],
          },
          attributes: ['userId', 'userName', 'score'],
          raw: true,
        });

        console.log(13);
        let topRank = JSON.parse(
          (
            await Table.findOne({
              where: { roomId },
              attributes: ['top'],
              raw: true,
            })
          ).top
        );
        console.log('승리 user 정보:::::', winner);
        console.log('topRank 정보:::::', topRank);
        topRank.unshift(winner);
        console.log('합친 정보:::::', topRank);

        let endingInfo = topRank;
        await Room.update(
          { isPlaying: false, turn: winner.userId },
          { where: { roomId } }
        );
        console.log(14);
        await Table.update(
          {
            blackCards: JSON.stringify([
              0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
            ]),
            whiteCards: JSON.stringify([
              0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
            ]),
            top: JSON.stringify([]),
          },
          { where: { roomId } }
        );
        console.log(15);

        await Promise.all(
          userInfo.map(async (el) => {
            await Player.update(
              {
                isReady: false,
                gameOver: false,
                hand: JSON.stringify([]),
                security: '',
              },
              { where: { userId: el.userId } }
            );
          })
        );

        let tableInfo = await Table.findOne({
          where: { roomId },
          attributes: ['blackCards', 'whiteCards', 'turn'],
          raw: true,
        });

        userInfoV2 = await Player.findAll({
          where: { roomId },
          attributes: [
            'userId',
            'userName',
            'isReady',
            'gameOver',
            'hand',
            'sids',
            'userProfileImg',
            'security',
            'needToBeDeleted',
          ],
          raw: true,
        });
        console.log('초기화 한 user data', userInfoV2);
        console.log(16);

        console.log(18);
        function infoV2(temp) {
          const some = userInfoV2.map((el) => {
            return {
              userId: el.userId,
              userName: el.userName,
              userProfileImg: el.userProfileImg,
              isReady: el.isReady,
              gameOver: el.gameOver ? true : false,
              hand: JSON.parse(el.hand).map((card) => {
                if (card == '[]') {
                  return card;
                } else if (el.userId === temp.userId) {
                  return {
                    color: card.color,
                    value: card.value,
                    isOpen: card.isOpen,
                  };
                } else if (!card.isOpen) {
                  return {
                    color: card.color,
                    value: 'Back',
                    isOpen: card.isOpen,
                  };
                } else {
                  return {
                    color: card.color,
                    value: card.value,
                    isOpen: card.isOpen,
                  };
                }
              }),
            };
          });
          console.log(19);
          (no_security = userCard.security.length === 0 ? false : true),
            (guessResult = {
              blackCards: JSON.parse(tableInfo.blackCards).length,
              whiteCards: JSON.parse(tableInfo.whiteCards).length,
              turn: tableInfo.turn,
              users: some,
            });
          return guessResult;
        }

        console.log(20);
        // TODO:  게임 오버
        userInfo.forEach((el) => {
          const gameInfo = infoV2(el);
          console.log('endingInfo:::::', endingInfo);
          console.log('gameInfo:::::', gameInfo);
          if (!el.needToBeDeleted)
            io.to(el.sids).emit(eventName.GAMEOVER, endingInfo, gameInfo);
        });
      } else {
        userInfo.forEach((el) => {
          if (!el.needToBeDeleted) {
            const table = info(el);
            io.to(el.sids).emit(
              eventName.RESULT_GUESS,
              result,
              no_security,
              table
            );
          }
        });
      }
    });

    socket.on(eventName.PLACE_JOKER, async (hand) => {
      const userId = socket.data.userId;
      const roomId = socket.data.roomId;
      // hand가 있으면 수정해서 보내주고,
      // 없으면 그냥 전체적인Info  // 없을 때는 Null

      // hand가 있을 때
      if (hand) {
        await Player.update(
          { hand: JSON.stringify(hand) },
          { where: { userId } }
        );
      } else {
        // TODO: 담보 불러서 저장하기.
        let userInfo = await Player.findOne({
          where: { userId, [Op.and]: [{ roomId }] },
          attributes: ['security', 'hand'],
          raw: true,
        });

        console.log(userInfo.security);
        console.log(userInfo.hand);

        let userSecurity = JSON.parse(userInfo.security);
        let userHand = JSON.parse(userInfo.hand);
        userSecurity.isOpen = false;

        userHand.push(userSecurity);
        console.log('place-joker 변한 userHand 값: ', userHand);

        let jokerIndex = [];
        let jokerCard = [];
        for (let i = 0; i < userHand.length; i++) {
          if (userHand[i].value === 12) {
            jokerIndex.push(i);
            jokerCard.push(userHand[i]);
          }
        }

        jokerIndex.map((el, i) => {
          userHand.splice(el - i, 1);
        });

        userHand
          .sort((a, b) => a.value - b.value)
          .sort((a, b) => {
            if (a.value === b.value) {
              if (a.color < b.color) return -1;
              else if (b.color < a.color) return 1;
              else return 0;
            }
          });

        for (let i = 0; i < jokerIndex.length; i++) {
          userHand.splice(jokerIndex[i], 0, jokerCard[i]);
        }

        await Player.update(
          { hand: JSON.stringify(userHand) },
          { where: { userId } }
        );
      }

      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'gameOver',
          'hand',
          'sids',
          'needToBeDeleted',
          'userProfileImg',
        ],
        raw: true,
      });

      let tableInfo = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards', 'users', 'turn'],
        raw: true,
      });

      function info(temp) {
        const gameInfo = userInfo.map((el) => {
          return {
            userId: el.userId,
            userName: el.userName,
            userProfileImg: el.userProfileImg,
            gameOver: el.gameOver ? true : false,
            hand: JSON.parse(el.hand).map((card) => {
              if (el.userId === temp.userId) {
                return {
                  color: card.color,
                  value: card.value,
                  isOpen: card.isOpen,
                };
              } else if (!card.isOpen) {
                return {
                  color: card.color,
                  value: 'Back',
                  isOpen: card.isOpen,
                };
              } else {
                return {
                  color: card.color,
                  value: card.value,
                  isOpen: card.isOpen,
                };
              }
            }),
          };
        });
        cardResult = {
          blackCards: JSON.parse(tableInfo.blackCards).length,
          whiteCards: JSON.parse(tableInfo.whiteCards).length,
          turn: tableInfo.turn,
          users: gameInfo,
        };
        return cardResult;
      }
      userInfo.forEach((el) => {
        if (!el.needToBeDeleted) {
          const result = info(el);
          io.to(el.sids).emit(eventName.ONGOING, result);
        }
      });
    });

    socket.on(
      eventName.SELECT_CARD_AS_SECURITY,
      async (userId, color, value) => {
        await Player.update(
          { security: JSON.stringify({ color, value }) },
          { where: { userId } }
        );
      }
    );

    socket.on(eventName.NEXT_TURN, async () => {
      const roomId = socket.data.roomId;

      let tableInfo = await Table.findOne({
        where: { roomId },
        attributes: ['blackCards', 'whiteCards', 'users', 'turn'],
        raw: true,
      });

      let userInfo = await Player.findAll({
        where: { roomId },
        attributes: [
          'userId',
          'userName',
          'gameOver',
          'hand',
          'sids',
          'userProfileImg',
        ],
        raw: true,
      });

      let turns = JSON.parse(tableInfo.users);
      let nextTurn = tableInfo.turn;
      let turnIndex = 0;

      for (let i = 0; i < turns.length; i++) {
        if (turns[i].userId === nextTurn) {
          turnIndex = i;
          break;
        }
      }

      let flag = 0;

      for (let i = 1; i < turns.length + 1; i++) {
        for (let j = 0; j < userInfo.length; j++) {
          if (
            turns[(turnIndex + i) % turns.length].userId ==
              userInfo[j].userId &&
            !userInfo[j].gameOver
          ) {
            nextTurn = userInfo[j].userId;
            flag = 1;
            break;
          }
        }
        if (flag) {
          break;
        }
      }

      await Table.update({ turn: nextTurn }, { where: { roomId } });

      function info(temp) {
        const gameInfo = userInfo.map((el) => {
          return {
            userId: el.userId,
            userName: el.userName,
            userProfileImg: el.userProfileImg,
            gameOver: el.gameOver ? true : false,
            hand: JSON.parse(el.hand).map((card) => {
              if (el.userId === temp.userId) {
                return {
                  color: card.color,
                  value: card.value,
                  isOpen: card.isOpen,
                };
              } else if (!card.isOpen) {
                return {
                  color: card.color,
                  value: 'Back',
                  isOpen: card.isOpen,
                };
              } else {
                return {
                  color: card.color,
                  value: card.value,
                  isOpen: card.isOpen,
                };
              }
            }),
          };
        });
        cardResult = {
          blackCards: JSON.parse(tableInfo.blackCards).length,
          whiteCards: JSON.parse(tableInfo.whiteCards).length,
          turn: nextTurn,
          users: gameInfo,
        };
        return cardResult;
      }
      userInfo.forEach((el) => {
        if (!el.needToBeDeleted) {
          const result = info(el);
          io.to(el.sids).emit(eventName.NEXT_GAMEINFO, result);
        }
      });
    });

    socket.on(eventName.ROOM_OUT, async () => {
      // 방 나갈 때
      const roomId = socket.data.roomId;
      const userId = socket.data.userId;
      console.log(roomId);
      console.log(userId);
      let userInfoV2;
      let userInfo;
      let nextTurn;

      const room = await Room.findOne({ where: { roomId } });
      const player = await Player.findAll({
        where: { roomId },
        attributes: ['userId', 'userName', 'gameOver', 'hand', 'sids'],
        raw: true,
      });
      const table = await room.getTable();

      let isPlaying = (
        await Room.findOne({
          where: { roomId },
          attributes: ['isPlaying'],
          raw: true,
        })
      ).isPlaying;
      console.log('isPlaying', isPlaying);
      const users = JSON.parse(table.users);

      if (users.length > 1) {
        if (table.turn === userId) {
          console.log(users);

          let turns = JSON.parse(table.users);
          nextTurn = table.turn;
          let turnIndex = 0;

          for (let i = 0; i < turns.length; i++) {
            if (turns[i].userId === nextTurn) {
              turnIndex = i;
              break;
            }
          }

          let flag = 0;

          for (let i = 1; i < turns.length + 1; i++) {
            for (let j = 0; j < player.length; j++) {
              if (
                turns[(turnIndex + i) % turns.length].userId ==
                  player[j].userId &&
                !player[j].gameOver
              ) {
                nextTurn = player[j].userId;
                flag = 1;
                break;
              }
            }
            if (flag) {
              break;
            }
          }

          await Table.update({ turn: nextTurn }, { where: { roomId } });

          // let count = 0;
          // for (let i = 0; i < users.length; i++) {
          //   if (users[i].userId === table.turn) {
          //     for (let j = 1; j < 4; j++) {
          //       player.map((el) => {
          //         if (count == 0) {
          //           if (
          //             el.userId === users[(i + j) % room.maxMembers].userId &&
          //             !el.gameOver
          //           ) {
          //             console.log(
          //               '이전 이전 이전 이전 이전 이전 turntable.turn',
          //               table.turn
          //             );
          //             table.turn = el.userId;
          //             count = 1;
          //             console.log(
          //               '이후 이후 이후 이후 이후 이후 turntable.turn',
          //               table.turn
          //             );
          //           }
          //         }
          //       });
          //       break;
          //     }
          //   }
          // }
        }
      }

      for (let i = 0; i < users.length; i++) {
        if (users[i].userId == userId) {
          users.splice(i, 1);
          break;
        }
      }

      if (users.length == 0) {
        await Room.destroy({ where: { roomId } });
      }

      // 해당 턴이였던 사람이 나가면 다음 사람으로 턴 넘겨주기.
      // 여러명인 경우도 생각.

      await Table.update(
        {
          users: JSON.stringify(users),
          turn: nextTurn,
        },
        { where: { roomId } }
      );

      console.log(3);

      // 게임 진행중일 때
      if (isPlaying) {
        console.log(4);
        let outUser = await Player.findOne({
          where: {
            userId,
            [Op.and]: [{ roomId }],
          },
          attributes: [
            'userId',
            'userName',
            'score',
            'gameOver',
            'hand',
            'needToBeDeleted',
          ],
          raw: true,
        });

        let topRank = JSON.parse(
          (
            await Table.findOne({
              where: { roomId },
              attributes: ['top'],
              raw: true,
            })
          ).top
        );

        topRank.unshift({
          userId: outUser.userId,
          userName: outUser.userName,
          score: outUser.score,
        });

        await Table.update(
          { top: JSON.stringify(topRank) },
          { where: { roomId } }
        );

        console.log('outUser', outUser);

        let outUserHand = JSON.parse(outUser.hand);
        outUserHand.forEach((card) => {
          if (card.isOpen === false) card.isOpen = true;
        });
        outUser.hand = JSON.stringify(outUserHand);

        await Player.update(
          {
            gameOver: true,
            needToBeDeleted: true,
            hand: outUser.hand,
          },
          { where: { userId, [Op.and]: [{ roomId }] } }
        );

        console.log('outUser 진행 1');
        userInfo = await Player.findAll({
          where: { roomId },
          attributes: [
            'userId',
            'userName',
            'gameOver',
            'hand',
            'sids',
            'needToBeDeleted',
          ],
          raw: true,
        });
        console.log('outUser다음 진행 확인.2');
        console.log(userInfo.filter((user) => user.gameOver == false).length);
        // 게임이 끝난 상태인지 확인.
        if (userInfo.filter((user) => user.gameOver == false).length === 1) {
          console.log(
            '====================================GAME OVER===================================='
          );
          const winner = await Player.findOne({
            where: {
              roomId,
              [Op.and]: [{ gameOver: false }],
            },
            attributes: ['userId', 'userName', 'score'],
            raw: true,
          });

          console.log(13);
          let topRank = JSON.parse(
            (
              await Table.findOne({
                where: { roomId },
                attributes: ['top'],
                raw: true,
              })
            ).top
          );
          console.log('승리 user 정보:::::', winner);
          console.log('topRank 정보:::::', topRank);
          topRank.unshift(winner);
          console.log('합친 정보:::::', topRank);

          let endingInfo = topRank;
          await Room.update(
            { isPlaying: false, turn: winner.userId },
            { where: { roomId } }
          );
          console.log(14);
          await Table.update(
            {
              blackCards: JSON.stringify([
                0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
              ]),
              whiteCards: JSON.stringify([
                0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
              ]),
              top: JSON.stringify([]),
            },
            { where: { roomId } }
          );
          console.log(15);

          await Promise.all(
            userInfo.map(async (el) => {
              await Player.update(
                {
                  isReady: false,
                  gameOver: false,
                  hand: JSON.stringify([]),
                  security: '',
                },
                { where: { userId: el.userId } }
              );
            })
          );

          let tableInfo = await Table.findOne({
            where: { roomId },
            attributes: ['blackCards', 'whiteCards', 'turn'],
            raw: true,
          });

          userInfoV2 = await Player.findAll({
            where: { roomId },
            attributes: [
              'userId',
              'userName',
              'isReady',
              'gameOver',
              'hand',
              'sids',
              'userProfileImg',
              'security',
              'needToBeDeleted',
            ],
            raw: true,
          });

          console.log(18);
          function infoV2(temp) {
            const some = userInfoV2.map((el) => {
              return {
                userId: el.userId,
                userName: el.userName,
                userProfileImg: el.userProfileImg,
                isReady: el.isReady,
                gameOver: el.gameOver ? true : false,
                hand: JSON.parse(el.hand).map((card) => {
                  if (card == '[]') {
                    return card;
                  } else if (el.userId === temp.userId) {
                    return {
                      color: card.color,
                      value: card.value,
                      isOpen: card.isOpen,
                    };
                  } else if (!card.isOpen) {
                    return {
                      color: card.color,
                      value: 'Back',
                      isOpen: card.isOpen,
                    };
                  } else {
                    return {
                      color: card.color,
                      value: card.value,
                      isOpen: card.isOpen,
                    };
                  }
                }),
              };
            });
            console.log(19);

            guessResult = {
              blackCards: JSON.parse(tableInfo.blackCards).length,
              whiteCards: JSON.parse(tableInfo.whiteCards).length,
              turn: tableInfo.turn,
              users: some,
            };
            return guessResult;
          }

          console.log(20);
          // TODO:  게임 오버
          userInfo.forEach((el) => {
            const gameInfo = infoV2(el);

            if (!el.needToBeDeleted) {
              io.to(el.sids).emit(eventName.GAMEOVER, endingInfo, gameInfo);
            }
          });

          userInfoV2.map(async (user) => {
            if (user.needToBeDeleted === 1) {
              await Player.destroy({
                where: { userId: user.userId, [Op.and]: [{ roomId }] },
              });
            }
          });
        }
        // 게임 진행중이 아닐 때.
      } else {
        // 마지막 유저가 나갈 때 방 삭제.

        await Player.destroy({ where: { userId } });

        console.log('just roomOut');

        userInfo = await Player.findAll({
          where: { roomId },
          attributes: [
            'userId',
            'userName',
            'gameOver',
            'hand',
            'sids',
            'needToBeDeleted',
            'userProfileImg',
          ],
          raw: true,
        });

        const room = await Room.findOne({ where: { roomId } });

        function info(temp) {
          const gameInfo = userInfo.map((el) => {
            return {
              userId: el.userId,
              userName: el.userName,
              userProfileImg: el.userProfileImg,
              gameOver: el.gameOver ? true : false,
              hand: JSON.parse(el.hand).map((card) => {
                if (el.userId === temp.userId) {
                  return {
                    color: card.color,
                    value: card.value,
                    isOpen: card.isOpen,
                  };
                } else if (!card.isOpen) {
                  return {
                    color: card.color,
                    value: 'Back',
                    isOpen: card.isOpen,
                  };
                } else {
                  return {
                    color: card.color,
                    value: card.value,
                    isOpen: card.isOpen,
                  };
                }
              }),
            };
          });
          cardResult = {
            blackCards: JSON.parse(table.blackCards).length,
            whiteCards: JSON.parse(table.whiteCards).length,
            turn: table.turn,
            users: gameInfo,
          };
          return cardResult;
        }

        const roomInfo = {
          maxMembers: room.maxMembers,
          members: userInfo.length,
          isPlaying: room.isPlaying,
          secret: room.password ? true : false,
          roomId: room.roomId,
          roomName: room.roomName,
        };

        userInfo.forEach((el) => {
          if (!el.needToBeDeleted) {
            const result = info(el);
            io.to(el.sids).emit(eventName.LEAVE_USER, result, roomInfo);
          }
        });
      }
    });
  } catch (err) {
    console.error(err);

    if (err instanceof CustomError) {
      io.to(socket.id).emit(eventName.ERROR, err);
    } else {
      const newError = new CustomError('알 수 없는 오류가 발생했습니다.', 999);

      io.to(socket.id).emit(eventName.ERROR, newError);
    }

    socket.disconnect(true);
  }
});

server.listen(process.env.PORT, () => {
  console.log('Server is Listening');
});
