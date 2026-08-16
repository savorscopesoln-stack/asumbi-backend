const users = []; // temporary in-memory storage

const findUserByUsername = (username) => {
  return users.find((user) => user.username === username);
};

const createUser = (user) => {
  users.push(user);
  return user;
};

module.exports = {
  findUserByUsername,
  createUser,
};